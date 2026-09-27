import type { Bot } from 'mineflayer';
import type { Config } from '../config/config.js';
import { LlmError, type LLMProvider, type LlmMessage, type LlmOutputMode } from '../llm/provider.js';
import { decisionFromToolCall, parseDecisionFromText, type ParseOutcome } from '../llm/parser.js';
import { BlockActions } from '../minecraft/blocks.js';
import { BotSession } from '../minecraft/bot.js';
import { CombatController } from '../minecraft/combat.js';
import { CraftingManager } from '../minecraft/crafting.js';
import { ChatCommandListener } from '../minecraft/chat-commands.js';
import { EventAggregator } from '../minecraft/events.js';
import { InventoryManager } from '../minecraft/inventory.js';
import { MovementController } from '../minecraft/movement.js';
import { WorldObserver } from '../minecraft/observer.js';
import { GameRegistry } from '../minecraft/registry.js';
import { ReactiveSafety } from '../minecraft/safety.js';
import { startViewer, type ViewerHandle } from '../minecraft/viewer.js';
import { createToolRegistry, type ToolRegistry } from '../tools/index.js';
import type { ActionRecord, AgentDecision, ToolResult, WorldState } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';
import { round } from '../utils/spatial.js';
import { MemoryManager } from './memory.js';
import { GoalManager } from './planner.js';
import { buildCorrectionPrompt, buildCyclePrompt, buildSystemPrompt } from './prompts.js';

/** How many correction round-trips a single decision may take. */
const MAX_DECISION_ATTEMPTS = 3;

export interface CycleResult {
  kind: 'acted' | 'goal_complete' | 'llm_error' | 'undecidable' | 'disconnected';
  decision?: AgentDecision;
  result?: ToolResult;
  detail?: string;
}

/**
 * The agent: perception, memory, goal tracking, an LLM, and a validated tool
 * surface, wired into one observe → decide → act → observe cycle.
 */
export class Agent {
  public readonly goals: GoalManager;
  public readonly memory: MemoryManager;
  public readonly tools: ToolRegistry;

  private readonly cfg: Config;
  private readonly provider: LLMProvider;
  /** Untagged root logger, handed to subsystems so they can add their own tag. */
  private readonly baseLog: Logger | undefined;
  private readonly log: Logger;
  private readonly session: BotSession;

  private bot!: Bot;
  private registry!: GameRegistry;
  private observer!: WorldObserver;
  private movement!: MovementController;
  private inventory!: InventoryManager;
  private combat!: CombatController;
  private blocks!: BlockActions;
  private crafting!: CraftingManager;
  private events!: EventAggregator;
  private safety!: ReactiveSafety;
  private chatCommands: ChatCommandListener | null = null;
  private viewer: ViewerHandle | null = null;
  private paused = false;
  /** Set when an in-game command asks the run to end. */
  private stopRequest: string | null = null;

  private systemPrompt = '';
  /** Set in control mode so each outcome is mirrored into the control folder. */
  private resultSink: ((result: unknown) => void | Promise<void>) | null = null;
  private started = false;
  /** Guidance queued for the next prompt (corrections, safety notes). */
  private pendingGuidance: string[] = [];

  /**
   * `session` is injectable so the whole observe/decide/act path can be
   * exercised against a fake Mineflayer bot in tests, with no server involved.
   */
  public constructor(cfg: Config, provider: LLMProvider, logger?: Logger, session?: BotSession) {
    this.cfg = cfg;
    this.provider = provider;
    this.baseLog = logger;
    this.log = tagged('BOT', logger);
    this.goals = new GoalManager(cfg.agent.goal, logger);
    this.memory = new MemoryManager(cfg.agent, logger);
    this.tools = createToolRegistry(logger);
    this.session = session ?? new BotSession(cfg.minecraft, logger);
  }

  public get botSession(): BotSession {
    return this.session;
  }

  /** The full system prompt, so control mode can publish it as a briefing. */
  public get systemPromptText(): string {
    return this.systemPrompt;
  }

  /** URL of the live 3D view, when one was started. */
  public get viewerUrl(): string | null {
    return this.viewer?.url ?? null;
  }

  /** Connects to the server and builds every subsystem. */
  public async start(): Promise<Bot> {
    if (this.started) return this.bot;

    this.bot = await this.session.connect();
    this.registry = GameRegistry.fromBotVersion(this.bot.version);

    this.movement = new MovementController(this.bot, this.cfg.agent, this.baseLog);
    this.inventory = new InventoryManager(this.bot, this.registry, this.movement, this.baseLog);
    this.combat = new CombatController(this.bot, this.registry, this.movement, this.baseLog);
    this.blocks = new BlockActions(this.bot, this.registry, this.movement, this.inventory, this.baseLog);
    this.crafting = new CraftingManager(this.bot, this.registry, this.movement, this.inventory, this.baseLog);
    this.observer = new WorldObserver(this.bot, this.registry, this.cfg.agent);
    this.observer.setEnclosureProbe(() => this.blocks.describeEnclosure());

    this.events = new EventAggregator(
      this.bot,
      this.registry,
      (event) => this.memory.recordEvent(event),
      this.baseLog,
    );
    this.events.attach();

    this.safety = new ReactiveSafety(
      this.bot,
      this.cfg.agent,
      this.movement,
      this.combat,
      this.inventory,
      this.baseLog,
    );
    this.safety.setPitEscape({
      isEnclosed: () => this.blocks.describeEnclosure().enclosed,
      climbOut: async (height) => {
        const result = await this.blocks.pillarUp(height, { timeoutMs: 15_000 });
        return result.success;
      },
    });
    this.safety.attach();

    this.chatCommands = new ChatCommandListener(
      this.bot,
      this.cfg.chat,
      {
        setGoal: (goal) => this.changeGoal(goal),
        status: () => this.describeStatus(),
        stop: (reason) => {
          this.stopRequest = reason;
        },
        pause: () => {
          this.paused = true;
        },
        resume: () => {
          this.paused = false;
        },
      },
      this.baseLog,
    );
    this.chatCommands.attach();

    if (this.cfg.viewer.enabled) {
      this.viewer = await startViewer(
        this.bot,
        {
          port: this.cfg.viewer.port,
          firstPerson: this.cfg.viewer.firstPerson,
          distance: Math.max(4, Math.ceil(this.cfg.agent.observationRadius / 2)),
        },
        this.baseLog,
      );
    }

    this.systemPrompt = buildSystemPrompt({
      cfg: this.cfg.agent,
      mode: this.outputMode(),
      toolCatalogue: this.tools.describeForPrompt(),
      toolNames: this.tools.names(),
      minecraftVersion: this.bot.version,
    });

    this.started = true;
    return this.bot;
  }

  public stop(reason = 'agent stopped'): void {
    if (!this.started) {
      this.session.quit(reason);
      return;
    }
    this.safety.detach();
    this.events.detach();
    this.chatCommands?.detach();
    this.movement.stop();
    this.viewer?.close();
    this.session.quit(reason);
  }

  private outputMode(): LlmOutputMode {
    if (this.cfg.llm.mode === 'json') return 'json';
    return this.provider.supportsToolCalling() ? 'tools' : 'json';
  }

  /* ─────────────────────────────── observe ────────────────────────────── */

  public observe(): WorldState {
    const state = this.observer.observe();
    this.memory.learnFromObservation(state);
    this.goals.observeProgress(state);
    return state;
  }

  /* ──────────────────────────────── cycle ─────────────────────────────── */

  /** One full observe → decide → act → remember cycle. */
  public async runCycle(): Promise<CycleResult> {
    if (!this.session.isConnected) {
      return { kind: 'disconnected', detail: this.session.endState?.details ?? 'connection lost' };
    }

    const state = this.observe();
    const observeLog = tagged('OBSERVE', this.baseLog);
    observeLog.info(
      `HP=${state.player.health} Food=${state.player.food} Pos=${state.player.position.x},${state.player.position.y},${state.player.position.z} ` +
        `Blocks=${state.nearbyBlocks.length} Entities=${state.entities.length} Threats=${state.threats.length} Items=${state.inventory.length}`,
    );

    // Fold any reflex the safety layer performed into this cycle's guidance, so
    // the model knows why its last action may have been cut short.
    const safetyReport = this.safety.consumeReport();
    if (safetyReport.action !== 'none') {
      this.pendingGuidance.push(`Safety layer acted automatically: ${safetyReport.detail}`);
    }

    const decision = await this.decide(state);
    if (!decision.ok) {
      return decision.kind === 'llm_error'
        ? { kind: 'llm_error', detail: decision.detail }
        : { kind: 'undecidable', detail: decision.detail };
    }

    this.goals.beginCycle(decision.decision.reason);

    if (decision.decision.remember) {
      this.memory.remember(decision.decision.remember);
    }

    if (decision.decision.goalComplete) {
      const verdict = this.goals.tryComplete(decision.decision.reason, state);
      if (verdict.accepted) {
        return { kind: 'goal_complete', decision: decision.decision, detail: verdict.explanation };
      }
      // Rejected: tell the model why and let it keep acting this same cycle.
      this.pendingGuidance.push(verdict.explanation);
    }

    const result = await this.execute(decision.decision);
    return { kind: 'acted', decision: decision.decision, result };
  }

  /* ─────────────────────────────── decide ─────────────────────────────── */

  /**
   * Asks the model for one action, retrying with a structured correction when
   * the reply is malformed or names a tool that does not exist.
   */
  private async decide(
    state: WorldState,
  ): Promise<
    | { ok: true; decision: AgentDecision }
    | { ok: false; kind: 'llm_error' | 'undecidable'; detail: string }
  > {
    const llmLog = tagged('LLM', this.baseLog);
    const mode = this.outputMode();

    const events = this.memory.takeEvents();
    const guidance = this.pendingGuidance;
    this.pendingGuidance = [];

    const userPrompt = buildCyclePrompt({
      goals: this.goals,
      state,
      memory: this.memory.snapshot(),
      events,
      cfg: this.cfg.agent,
      guidance,
    });

    const messages: LlmMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    for (let attempt = 1; attempt <= MAX_DECISION_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await this.provider.complete({
          messages,
          mode,
          ...(mode === 'tools' ? { tools: this.tools.specs() } : {}),
        });
      } catch (err) {
        if (err instanceof LlmError && err.code === 'TOOLS_UNSUPPORTED') {
          // The provider has now flipped to JSON mode; rebuild the system prompt
          // so the model is told the JSON contract, and try again.
          if (this.cfg.viewer.enabled) {
      this.viewer = await startViewer(
        this.bot,
        {
          port: this.cfg.viewer.port,
          firstPerson: this.cfg.viewer.firstPerson,
          distance: Math.max(4, Math.ceil(this.cfg.agent.observationRadius / 2)),
        },
        this.baseLog,
      );
    }

    this.systemPrompt = buildSystemPrompt({
            cfg: this.cfg.agent,
            mode: 'json',
            toolCatalogue: this.tools.describeForPrompt(),
            toolNames: this.tools.names(),
            minecraftVersion: this.bot.version,
          });
          messages[0] = { role: 'system', content: this.systemPrompt };
          continue;
        }
        const detail = err instanceof Error ? err.message : String(err);
        llmLog.error(`request failed: ${detail}`);
        return { ok: false, kind: 'llm_error', detail };
      }

      const outcome = this.interpret(response.toolCalls, response.content);

      if (outcome.ok) {
        llmLog.info(
          {
            tool: outcome.decision.tool,
            latencyMs: response.latencyMs,
            tokens: response.usage?.totalTokens,
          },
          `Decision: ${outcome.decision.tool} — ${outcome.decision.reason || '(no reason given)'}`,
        );
        return { ok: true, decision: outcome.decision };
      }

      // Unknown tool names are handled here rather than at execution time, so a
      // typo costs one correction turn instead of a wasted cycle.
      const problem = outcome.message;
      llmLog.warn(`unusable response (attempt ${attempt}/${MAX_DECISION_ATTEMPTS}): ${problem}`);

      if (attempt === MAX_DECISION_ATTEMPTS) {
        return { ok: false, kind: 'undecidable', detail: problem };
      }

      messages.push({
        role: 'assistant',
        content: response.content ?? '(no content)',
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      });
      // Replaying a tool_calls turn requires a matching tool result message.
      if (response.toolCalls.length > 0) {
        for (const call of response.toolCalls) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ success: false, error: 'INVALID_ARGUMENTS', details: problem }),
          });
        }
      }
      messages.push({ role: 'user', content: buildCorrectionPrompt(problem, this.tools.names()) });
    }

    /* c8 ignore next — loop always returns. */
    return { ok: false, kind: 'undecidable', detail: 'exhausted decision attempts' };
  }

  /** Turns a raw completion into a validated decision, whatever form it took. */
  private interpret(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    content: string | null,
  ): ParseOutcome {
    const call = toolCalls[0];
    if (call) {
      const outcome = decisionFromToolCall(call.name, call.arguments, content);
      if (!outcome.ok) return outcome;
      if (!this.tools.has(outcome.decision.tool)) {
        return {
          ok: false,
          code: 'SCHEMA_MISMATCH',
          message: `"${outcome.decision.tool}" is not an available tool. Choose one of: ${this.tools.names().join(', ')}.`,
        };
      }
      return outcome;
    }

    // No tool call: the model may still have produced the JSON contract.
    const outcome = parseDecisionFromText(content);
    if (!outcome.ok) return outcome;
    if (!this.tools.has(outcome.decision.tool)) {
      return {
        ok: false,
        code: 'SCHEMA_MISMATCH',
        message: `"${outcome.decision.tool}" is not an available tool. Choose one of: ${this.tools.names().join(', ')}.`,
      };
    }
    return outcome;
  }

  /* ─────────────────────────────── execute ────────────────────────────── */

  public async execute(decision: AgentDecision): Promise<ToolResult> {
    const toolLog = tagged('TOOL', this.baseLog);
    const resultLog = tagged('RESULT', this.baseLog);

    toolLog.info(`${decision.tool}(${JSON.stringify(decision.arguments)})`);

    const signal = this.safety.createActionSignal();
    const result = await this.tools.execute(decision.tool, decision.arguments, {
      bot: this.bot,
      registry: this.registry,
      observer: this.observer,
      movement: this.movement,
      inventory: this.inventory,
      combat: this.combat,
      blocks: this.blocks,
      crafting: this.crafting,
      cfg: this.cfg.agent,
      log: this.baseLog ?? this.log,
      signal,
    });
    this.safety.clearActionSignal();

    const record: ActionRecord = {
      tool: decision.tool,
      arguments: decision.arguments,
      reason: decision.reason,
      success: result.success,
      durationMs: result.durationMs,
      at: Date.now(),
      ...(result.success ? {} : { error: result.error, details: result.details }),
    };
    this.memory.recordAction(record);

    if (this.resultSink) {
      void Promise.resolve(
        this.resultSink({
          tool: decision.tool,
          arguments: decision.arguments,
          reason: decision.reason,
          ...(result.success
            ? { success: true, data: result.data }
            : { success: false, error: result.error, details: result.details }),
          durationMs: result.durationMs,
        }),
      ).catch(() => undefined);
    }

    if (result.success) {
      resultLog.info(
        `success=true tool=${decision.tool} duration=${round(result.durationMs / 1000, 2)}s ${summarizeData(result.data)}`,
      );
      this.noteStructures(decision, result);
    } else {
      resultLog.warn(
        `success=false tool=${decision.tool} error=${result.error} duration=${round(result.durationMs / 1000, 2)}s :: ${result.details}`,
      );
    }

    return result;
  }

  /**
   * Records workstation locations from successful results, so the model does not
   * have to re-find the crafting table it just used.
   */
  private noteStructures(decision: AgentDecision, result: ToolResult): void {
    if (!result.success || typeof result.data !== 'object' || result.data === null) return;
    const data = result.data as Record<string, unknown>;

    if (decision.tool === 'craft' && isPoint(data['tablePosition'])) {
      this.memory.noteLocation('crafting_table', data['tablePosition']);
    }
    if (decision.tool === 'smelt' && isPoint(data['furnacePosition']) && typeof data['furnace'] === 'string') {
      this.memory.noteLocation(data['furnace'], data['furnacePosition']);
    }
    if (decision.tool === 'place_block' && isPoint(data['position']) && typeof data['block'] === 'string') {
      this.memory.noteLocation(data['block'], data['position']);
    }
  }

  /* ─────────────────────────────── helpers ────────────────────────────── */

  public isInDanger(): boolean {
    return this.started && this.safety.isInDanger();
  }

  /** Mirrors every tool outcome somewhere else (used by the control surface). */
  public setResultSink(sink: (result: unknown) => void | Promise<void>): void {
    this.resultSink = sink;
  }

  public queueGuidance(message: string): void {
    this.pendingGuidance.push(message);
  }

  /** True while an in-game command has the agent paused. */
  public get isPaused(): boolean {
    return this.paused;
  }

  /** Reason an in-game command asked the run to stop, if any. */
  public get requestedStop(): string | null {
    return this.stopRequest;
  }

  /**
   * Replaces the goal mid-run. Memory of *facts* is kept — the world has not
   * changed — but the action history and failure streak are cleared, since they
   * were about the old objective.
   */
  public changeGoal(goal: string): void {
    this.goals.setGoal(goal);
    this.observer.setGoalKeywords(goal);
    this.memory.resetFailureStreak();
    this.pendingGuidance.push(`Your goal has been changed to: ${goal}`);
    tagged('GOAL', this.baseLog).info(`goal changed in-game to: ${goal}`);
  }

  public describeStatus(): string {
    const state = this.memory.latestObservation();
    const goal = this.goals.snapshot();
    const last = this.memory.lastAction();
    const parts = [
      `goal="${goal.goal}"`,
      `cycles=${goal.cycles}`,
      state ? `hp=${state.player.health}/20 food=${state.player.food}/20` : 'not observed yet',
      last ? `last=${last.tool}:${last.success ? 'ok' : (last.error ?? 'fail')}` : 'no actions yet',
      this.paused ? 'PAUSED' : 'running',
    ];
    return parts.join(' ');
  }
}

function isPoint(value: unknown): value is { x: number; y: number; z: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { x?: unknown }).x === 'number' &&
    typeof (value as { y?: unknown }).y === 'number' &&
    typeof (value as { z?: unknown }).z === 'number'
  );
}

/** Short, log-friendly rendering of a tool's result payload. */
function summarizeData(data: unknown): string {
  if (data === null || data === undefined) return '';
  const json = JSON.stringify(data);
  if (json === undefined) return '';
  return json.length <= 220 ? json : `${json.slice(0, 219)}…`;
}
