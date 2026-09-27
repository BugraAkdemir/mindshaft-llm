import { mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tagged, type Logger } from '../utils/logger.js';
import {
  LlmError,
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolSpec,
} from './provider.js';

export interface ExternalControlConfig {
  /** Directory used to exchange turns with the external controller. */
  dir: string;
  /** How long to wait for a decision before giving up on the turn. */
  timeoutMs: number;
  /** How often to look for an action file. */
  pollIntervalMs: number;
}

const TURN_FILE = 'turn.json';
const ACTION_FILE = 'action.json';
const RESULT_FILE = 'last-result.json';
const HISTORY_FILE = 'history.jsonl';
const BRIEFING_FILE = 'briefing.md';
const READ_ME_FILE = 'README.md';

/**
 * An `LLMProvider` whose "model" is whatever is watching a directory.
 *
 * This is what lets a coding agent — Claude Code, Codex, or a person with a text
 * editor — play the game directly: the agent writes the current turn to
 * `control/turn.json` and waits for a decision in `control/action.json`. No API
 * key, no network, no HTTP client; just two files.
 *
 * Because it satisfies `LLMProvider`, every other part of the system is
 * unchanged — the same prompt construction, the same Zod validation, the same
 * timeouts and the same correction loop apply to a human-written action as to a
 * model-written one.
 */
export class ExternalControlProvider implements LLMProvider {
  public readonly name = 'external-control';
  public readonly model = 'external/controller';

  private readonly cfg: ExternalControlConfig;
  private readonly log: Logger;
  private turn = 0;
  private briefingWritten = false;

  public constructor(cfg: ExternalControlConfig, logger?: Logger) {
    this.cfg = cfg;
    this.log = tagged('LLM', logger);
  }

  /** Always JSON: a controller writes a decision object, never a tool call. */
  public supportsToolCalling(): boolean {
    return false;
  }

  public get directory(): string {
    return this.cfg.dir;
  }

  /** Creates the control directory and the instructions for whoever is driving. */
  public async prepare(tools: LlmToolSpec[], toolCatalogue: string): Promise<void> {
    await mkdir(this.cfg.dir, { recursive: true });
    // A stale action from a previous run would be executed immediately.
    await rm(join(this.cfg.dir, ACTION_FILE), { force: true });
    await writeFile(join(this.cfg.dir, READ_ME_FILE), buildControllerReadme(this.cfg, tools), 'utf8');
    await writeFile(join(this.cfg.dir, BRIEFING_FILE), buildBriefing(toolCatalogue), 'utf8');
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    this.turn += 1;

    await mkdir(this.cfg.dir, { recursive: true });

    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
    const user = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';

    if (!this.briefingWritten) {
      // The system prompt is long and identical every turn; write it once.
      await writeFile(join(this.cfg.dir, BRIEFING_FILE), buildBriefing(system), 'utf8');
      this.briefingWritten = true;
    }

    const turnPath = join(this.cfg.dir, TURN_FILE);
    const actionPath = join(this.cfg.dir, ACTION_FILE);

    // Clear any leftover action so a previous turn's file is never reused.
    await rm(actionPath, { force: true });

    await writeFile(
      turnPath,
      `${JSON.stringify(
        {
          turn: this.turn,
          waitingSince: new Date().toISOString(),
          waitingForFile: ACTION_FILE,
          respondWith: {
            reason: 'one short sentence explaining the choice',
            tool: 'one of the tool names listed in briefing.md',
            arguments: {},
            remember: '(optional) a durable fact worth keeping',
            goal_complete: false,
          },
          instructions:
            `Write your decision to ${ACTION_FILE} in this directory as a single JSON object. ` +
            `See ${BRIEFING_FILE} for the goal, the rules and every available tool. ` +
            `The result of your action will appear in ${RESULT_FILE}.`,
          situation: user,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    this.log.info(`turn ${this.turn}: waiting for a decision in ${actionPath}`);

    const decision = await this.awaitAction(actionPath, request.signal);
    await rm(actionPath, { force: true });

    const latencyMs = Date.now() - startedAt;
    await appendFile(
      join(this.cfg.dir, HISTORY_FILE),
      `${JSON.stringify({ turn: this.turn, at: new Date().toISOString(), decision: safeParse(decision) })}\n`,
      'utf8',
    );

    return {
      content: decision,
      toolCalls: [],
      model: this.model,
      finishReason: 'stop',
      latencyMs,
    };
  }

  /** Records the outcome of the last action where the controller can see it. */
  public async publishResult(result: unknown): Promise<void> {
    try {
      await writeFile(
        join(this.cfg.dir, RESULT_FILE),
        `${JSON.stringify({ turn: this.turn, at: new Date().toISOString(), result }, null, 2)}\n`,
        'utf8',
      );
    } catch (err) {
      this.log.debug({ err }, 'could not write the result file');
    }
  }

  /**
   * Polls for the action file until it appears, the signal aborts, or time runs
   * out.
   *
   * An action may carry a `turn` field. When it does and it names a different
   * turn, the file is a leftover answer to an earlier situation — acting on it
   * would apply a stale decision to a world that has since changed — so it is
   * discarded and the wait continues. Actions without a `turn` are trusted, so
   * hand-written files stay easy.
   */
  private async awaitAction(actionPath: string, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.cfg.timeoutMs;
    let warnedStale = false;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new LlmError('control turn aborted', 'ABORTED', false);

      const content = await readIfPresent(actionPath);
      // A partially-written file reads as empty or invalid; try again next poll.
      if (content !== null && content.trim() !== '') {
        const stamped = readTurnStamp(content);

        if (stamped === null || stamped === this.turn) return content;

        if (!warnedStale) {
          warnedStale = true;
          this.log.warn(
            `discarding an action stamped for turn ${stamped} while on turn ${this.turn}; ` +
              'write the action only after turn.json shows the new turn number',
          );
        }
        await rm(actionPath, { force: true });
      }

      await sleep(this.cfg.pollIntervalMs);
    }

    throw new LlmError(
      `no decision was written to ${actionPath} within ${Math.round(this.cfg.timeoutMs / 1000)}s`,
      'TIMEOUT',
      true,
    );
  }
}

/* ────────────────────────────── file helpers ──────────────────────────── */

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads an optional `turn` stamp from an action file. */
export function readTurnStamp(content: string): number | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const turn = (parsed as { turn?: unknown }).turn;
    return typeof turn === 'number' && Number.isFinite(turn) ? turn : null;
  } catch {
    // Not JSON at all: let the decision parser produce the correction message.
    return null;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/* ─────────────────────────── generated documents ──────────────────────── */

function buildBriefing(systemPrompt: string): string {
  return `# Agent briefing

Everything below is the exact briefing the agent operates under. It lists the
rules, the limits, and every tool you may call.

---

${systemPrompt}
`;
}

function buildControllerReadme(cfg: ExternalControlConfig, tools: LlmToolSpec[]): string {
  const toolLines = tools
    .map((tool) => {
      const properties = (tool.parameters['properties'] ?? {}) as Record<string, { type?: string }>;
      const required = new Set((tool.parameters['required'] as string[] | undefined) ?? []);
      const params = Object.entries(properties)
        .map(([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${value.type ?? 'any'}`)
        .join(', ');
      return `| \`${tool.name}\` | ${params || '—'} |`;
    })
    .join('\n');

  return `# You are playing Minecraft

This directory is a turn-based control surface for a live Minecraft bot. You play
by reading one file and writing another. No API key, no network, no HTTP client.

## The loop

1. Read **\`${TURN_FILE}\`** — the current turn: where the bot is, what is nearby,
   what it is carrying, what just happened, and what the goal is.
2. Write **\`${ACTION_FILE}\`** — your decision, as one JSON object.
3. The bot executes it and writes the outcome to **\`${RESULT_FILE}\`**, then a new
   \`${TURN_FILE}\` appears with a higher \`turn\` number. Go to 1.

**Wait for the \`turn\` number to change before writing your next action.** If you
write \`${ACTION_FILE}\` while the bot is still executing the previous one, it may be
overwritten. Include \`"turn": <the number from ${TURN_FILE}>\` in your action and the
bot will ignore it if it ever arrives out of order — \`npm run act\` does this for
you automatically.

Read **\`${BRIEFING_FILE}\`** once before your first move: it has the full rules,
the coordinate conventions and every tool's arguments.

## Writing an action

\`\`\`json
{
  "reason": "there is an oak tree 3 blocks north-east and I need wood",
  "tool": "mine",
  "arguments": { "block": "oak_log", "count": 3 }
}
\`\`\`

Optional fields: \`"remember"\` (a fact to keep for later turns) and
\`"goal_complete": true\` (only when the goal is genuinely finished — a false
claim is checked against the inventory and rejected).

There is a convenience CLI if you prefer not to write JSON by hand:

\`\`\`bash
npm run act -- mine block=oak_log count=3
\`\`\`

\`\`\`bash
npm run act -- move_to x=126 y=64 z=-30
\`\`\`

## Rules that will bite you

- **One tool per turn.** Not a plan, not a list — the single next action.
- **Coordinates:** \`-Z\` is north, \`+X\` is east, \`+Y\` is up.
- Read the \`error\` and \`details\` in \`${RESULT_FILE}\` when something fails. They say
  exactly what went wrong. Do not retry an identical failing call.
- If \`${TURN_FILE}\` contains a \`STUCK\` field, the bot is walled in — use
  \`pillar_up\` before anything else.
- The bot waits ${Math.round(cfg.timeoutMs / 1000)} seconds for each decision, then gives up on
  that turn.

## Available tools

| Tool | Arguments |
| --- | --- |
${toolLines}

Argument types, bounds and descriptions are in \`${BRIEFING_FILE}\`.

## History

\`${HISTORY_FILE}\` is an append-only JSON-lines log of every decision, in case you
want to look back at what you already tried.
`;
}
