import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalControlProvider } from '../src/llm/external.js';
import { coerce, parseActArgs } from '../src/act.js';
import type { LlmRequest } from '../src/llm/provider.js';
import { createToolRegistry } from '../src/tools/index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mc-control-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function provider(timeoutMs = 3_000): ExternalControlProvider {
  return new ExternalControlProvider({ dir, timeoutMs, pollIntervalMs: 25 });
}

function request(userContent = 'the current situation'): LlmRequest {
  return {
    mode: 'json',
    messages: [
      { role: 'system', content: 'You are a Minecraft agent. Tools: observe, mine.' },
      { role: 'user', content: userContent },
    ],
  };
}

/**
 * Behaves like a well-mannered controller: waits for a turn number it has not
 * answered yet, then writes the action stamped with that turn.
 */
async function answerWhenAsked(
  decision: unknown,
  options: { afterTurn?: number; waitMs?: number; raw?: string } = {},
): Promise<void> {
  const afterTurn = options.afterTurn ?? 0;
  const deadline = Date.now() + (options.waitMs ?? 2_000);

  while (Date.now() < deadline) {
    const turn = await currentTurn();
    if (turn !== null && turn > afterTurn) {
      const body =
        options.raw ??
        JSON.stringify(
          typeof decision === 'object' && decision !== null ? { ...decision, turn } : decision,
        );
      await writeFile(join(dir, 'action.json'), body, 'utf8');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('provider never published a new turn');
}

async function currentTurn(): Promise<number | null> {
  if (!existsSync(join(dir, 'turn.json'))) return null;
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'turn.json'), 'utf8')) as { turn?: number };
    return parsed.turn ?? null;
  } catch {
    return null;
  }
}

describe('control surface setup', () => {
  it('writes instructions a controller can follow, listing the real tools', async () => {
    const control = provider();
    const registry = createToolRegistry();
    await control.prepare(registry.specs(), 'system prompt text');

    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('You are playing Minecraft');
    expect(readme).toContain('turn.json');
    expect(readme).toContain('action.json');
    // Every registered tool must be documented, including newer ones.
    expect(readme).toContain('`pillar_up`');
    expect(readme).toContain('`move_to`');
    expect(readme).toContain('npm run act');

    const briefing = await readFile(join(dir, 'briefing.md'), 'utf8');
    expect(briefing).toContain('system prompt text');
  });

  it('clears a stale action left over from a previous run', async () => {
    await writeFile(join(dir, 'action.json'), '{"tool":"mine","arguments":{}}', 'utf8');
    const control = provider();
    await control.prepare([], 'briefing');

    expect(existsSync(join(dir, 'action.json'))).toBe(false);
  });

  it('never claims to support native tool calling', () => {
    expect(provider().supportsToolCalling()).toBe(false);
  });
});

describe('turn exchange', () => {
  it('publishes the situation and returns the decision written back', async () => {
    const control = provider();
    const decision = { reason: 'wood is close', tool: 'mine', arguments: { block: 'oak_log' } };

    const [response] = await Promise.all([
      control.complete(request('oak_log x24 nearby')),
      answerWhenAsked(decision),
    ]);

    expect(response.content).toContain('oak_log');
    expect(response.toolCalls).toEqual([]);
    expect(response.model).toBe('external/controller');

    // The published turn carried the situation and told the controller what to do.
    const turn = JSON.parse(await readFile(join(dir, 'turn.json'), 'utf8')) as Record<string, unknown>;
    expect(turn['turn']).toBe(1);
    expect(turn['situation']).toBe('oak_log x24 nearby');
    expect(turn['waitingForFile']).toBe('action.json');
    expect(String(turn['instructions'])).toContain('action.json');
  });

  it('consumes the action so the next turn cannot reuse it', async () => {
    const control = provider();
    await Promise.all([
      control.complete(request()),
      answerWhenAsked({ reason: 'look', tool: 'observe', arguments: {} }),
    ]);

    expect(existsSync(join(dir, 'action.json'))).toBe(false);
  });

  it('numbers turns so a controller can tell a new one apart', async () => {
    const control = provider();

    await Promise.all([control.complete(request()), answerWhenAsked({ tool: 'observe' })]);
    await Promise.all([
      control.complete(request()),
      answerWhenAsked({ tool: 'observe' }, { afterTurn: 1 }),
    ]);

    const turn = JSON.parse(await readFile(join(dir, 'turn.json'), 'utf8')) as { turn: number };
    expect(turn.turn).toBe(2);
  });

  it('appends every decision to an audit log', async () => {
    const control = provider();
    await Promise.all([
      control.complete(request()),
      answerWhenAsked({ reason: 'first', tool: 'observe', arguments: {} }),
    ]);
    await Promise.all([
      control.complete(request()),
      answerWhenAsked({ reason: 'second', tool: 'jump', arguments: {} }, { afterTurn: 1 }),
    ]);

    const lines = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const second = JSON.parse(lines[1]!) as { turn: number; decision: { tool: string } };
    expect(second.turn).toBe(2);
    expect(second.decision.tool).toBe('jump');
  });

  it('records unparseable controller output rather than crashing', async () => {
    const control = provider();
    await Promise.all([
      control.complete(request()),
      answerWhenAsked(null, { raw: 'not json at all' }),
    ]);

    const line = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim();
    expect(line).toContain('raw');
  });

  it('discards an action stamped for an earlier turn', async () => {
    const control = provider(1_500);

    const pending = control.complete(request());
    await answerWhenAsked({ tool: 'observe', arguments: {} });
    await pending;

    // Answer turn 2 with a stale stamp, then with the correct one.
    const second = control.complete(request());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeFile(
      join(dir, 'action.json'),
      JSON.stringify({ tool: 'mine', arguments: { block: 'stone' }, turn: 1 }),
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    await writeFile(
      join(dir, 'action.json'),
      JSON.stringify({ tool: 'jump', arguments: {}, turn: 2 }),
      'utf8',
    );

    const response = await second;
    // The stale mine was dropped; the correctly-stamped jump was used.
    expect(response.content).toContain('jump');
    expect(response.content).not.toContain('stone');
  });

  it('accepts an unstamped action, so hand-written files stay easy', async () => {
    const control = provider(1_500);
    const pending = control.complete(request());
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeFile(join(dir, 'action.json'), JSON.stringify({ tool: 'observe' }), 'utf8');

    const response = await pending;
    expect(response.content).toContain('observe');
  });

  it('times out when no decision arrives', async () => {
    const control = provider(400);
    await expect(control.complete(request())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('aborts when the caller cancels', async () => {
    const control = provider(5_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);

    await expect(control.complete({ ...request(), signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('publishes the outcome where the controller can read it', async () => {
    const control = provider();
    await Promise.all([control.complete(request()), answerWhenAsked({ tool: 'observe' })]);

    await control.publishResult({ success: true, data: { health: 20 } });

    const result = JSON.parse(await readFile(join(dir, 'last-result.json'), 'utf8')) as {
      turn: number;
      result: { success: boolean };
    };
    expect(result.turn).toBe(1);
    expect(result.result.success).toBe(true);
  });
});

describe('act CLI argument parsing', () => {
  it('reads a tool and its key=value arguments', () => {
    const parsed = parseActArgs(['mine', 'block=oak_log', 'count=3']);
    expect(parsed.tool).toBe('mine');
    expect(parsed.args).toEqual({ block: 'oak_log', count: 3 });
  });

  it('accepts a bare tool with no arguments', () => {
    expect(parseActArgs(['observe']).tool).toBe('observe');
  });

  it('reads the optional flags', () => {
    const parsed = parseActArgs([
      'craft',
      'item=wooden_pickaxe',
      '--reason',
      'need a tool',
      '--remember',
      'table is at 10,64,10',
      '--goal-complete',
      '--dir',
      'other',
    ]);

    expect(parsed.reason).toBe('need a tool');
    expect(parsed.remember).toBe('table is at 10,64,10');
    expect(parsed.goalComplete).toBe(true);
    expect(parsed.dir).toBe('other');
  });

  it('recognises --show and --help', () => {
    expect(parseActArgs(['--show']).show).toBe(true);
    expect(parseActArgs(['--help']).help).toBe(true);
  });

  it('reports no tool when only flags are given', () => {
    expect(parseActArgs(['--reason', 'nothing']).tool).toBeNull();
  });

  it('coerces values to their natural types', () => {
    expect(coerce('3')).toBe(3);
    expect(coerce('-2.5')).toBe(-2.5);
    expect(coerce('true')).toBe(true);
    expect(coerce('false')).toBe(false);
    expect(coerce('null')).toBeNull();
    expect(coerce('oak_log')).toBe('oak_log');
    expect(coerce('{"a":1}')).toEqual({ a: 1 });
    expect(coerce('[1,2]')).toEqual([1, 2]);
  });

  it('keeps malformed JSON as a plain string rather than throwing', () => {
    expect(coerce('{broken')).toBe('{broken');
  });

  it('keeps a negative coordinate numeric', () => {
    expect(parseActArgs(['move_to', 'x=-30', 'y=64', 'z=12']).args).toEqual({ x: -30, y: 64, z: 12 });
  });
});
