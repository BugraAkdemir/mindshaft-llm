import type { Config } from '../config/config.js';
import { tagged, type Logger } from '../utils/logger.js';
import type { Agent } from './agent.js';

export type StopReason =
  | 'goal_achieved'
  | 'fatal_error'
  | 'manual_stop'
  | 'disconnected'
  | 'too_many_failures'
  | 'max_cycles';

export interface LoopSummary {
  reason: StopReason;
  detail: string;
  cycles: number;
  successes: number;
  failures: number;
  elapsedMs: number;
}

export interface LoopOptions {
  /** Hard cap on decision cycles. Omit for an unbounded run. */
  maxCycles?: number;
}

/**
 * The outer control loop.
 *
 * observe → compress → build context → decide → validate → execute → remember,
 * repeating until the goal is met, the run breaks down, or the operator stops it.
 * The pacing interval is skipped whenever the agent is in immediate danger, so
 * combat and escapes do not wait three seconds between actions.
 */
export class ActionLoop {
  private readonly agent: Agent;
  private readonly cfg: Config;
  private readonly log: Logger;

  private running = false;
  private stopRequested: { reason: StopReason; detail: string } | null = null;
  private cycles = 0;
  private successes = 0;
  private failures = 0;
  /** Resolves the current inter-cycle sleep early when a stop is requested. */
  private wake: (() => void) | null = null;

  public constructor(agent: Agent, cfg: Config, logger?: Logger) {
    this.agent = agent;
    this.cfg = cfg;
    this.log = tagged('GOAL', logger);
  }

  public get isRunning(): boolean {
    return this.running;
  }

  /** Requests a graceful stop; the current action finishes first. */
  public requestStop(reason: StopReason = 'manual_stop', detail = 'stop requested'): void {
    if (this.stopRequested) return;
    this.stopRequested = { reason, detail };
    this.wake?.();
  }

  public async run(options: LoopOptions = {}): Promise<LoopSummary> {
    if (this.running) throw new Error('Action loop is already running.');
    this.running = true;
    const startedAt = Date.now();

    // A dropped connection ends the loop even if it happens mid-sleep.
    void this.agent.botSession.waitForEnd().then((end) => {
      this.requestStop('disconnected', `${end.reason}: ${end.details}`);
    });

    try {
      while (true) {
        if (this.stopRequested) {
          return this.summarize(this.stopRequested.reason, this.stopRequested.detail, startedAt);
        }
        const inGameStop = this.agent.requestedStop;
        if (inGameStop !== null) {
          return this.summarize('manual_stop', inGameStop, startedAt);
        }
        // Paused from in-game chat: idle without burning LLM calls.
        if (this.agent.isPaused) {
          await this.sleep(1_000);
          continue;
        }
        if (options.maxCycles !== undefined && this.cycles >= options.maxCycles) {
          return this.summarize('max_cycles', `reached the ${options.maxCycles}-cycle limit`, startedAt);
        }

        this.cycles += 1;
        const cycle = await this.agent.runCycle();

        switch (cycle.kind) {
          case 'acted': {
            if (cycle.result?.success) this.successes += 1;
            else this.failures += 1;

            if (this.agent.memory.failureStreak >= this.cfg.agent.maxConsecutiveFailures) {
              return this.summarize(
                'too_many_failures',
                `${this.agent.memory.failureStreak} consecutive tool failures — the agent is stuck.`,
                startedAt,
              );
            }
            break;
          }

          case 'goal_complete':
            this.log.info(`goal achieved after ${this.cycles} cycles`);
            return this.summarize('goal_achieved', cycle.detail ?? 'goal reported complete', startedAt);

          case 'disconnected':
            return this.summarize('disconnected', cycle.detail ?? 'connection lost', startedAt);

          case 'llm_error': {
            this.failures += 1;
            // An LLM outage is not the agent's fault; back off and try again,
            // but do not spin forever if the provider stays broken.
            if (this.failures >= this.cfg.agent.maxConsecutiveFailures * 2) {
              return this.summarize(
                'fatal_error',
                `LLM requests keep failing: ${cycle.detail ?? 'unknown error'}`,
                startedAt,
              );
            }
            this.log.warn(`LLM error, backing off: ${cycle.detail}`);
            await this.sleep(Math.min(15_000, 2_000 * this.failures));
            continue;
          }

          case 'undecidable': {
            this.failures += 1;
            this.agent.queueGuidance(
              'Your last few replies could not be parsed. Reply with exactly one JSON object and no other text.',
            );
            if (this.failures >= this.cfg.agent.maxConsecutiveFailures * 2) {
              return this.summarize(
                'fatal_error',
                `Model never produced a usable action: ${cycle.detail ?? 'unknown'}`,
                startedAt,
              );
            }
            break;
          }
        }

        // Pace the loop, unless something is actively trying to kill us.
        if (this.cfg.agent.thinkIntervalMs > 0 && !this.agent.isInDanger()) {
          await this.sleep(this.cfg.agent.thinkIntervalMs);
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.log.error({ err }, `loop aborted: ${detail}`);
      return this.summarize('fatal_error', detail, startedAt);
    } finally {
      this.running = false;
      this.wake = null;
    }
  }

  /** Interruptible sleep — a stop request wakes it immediately. */
  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
    });
    this.wake = null;
  }

  private summarize(reason: StopReason, detail: string, startedAt: number): LoopSummary {
    return {
      reason,
      detail,
      cycles: this.cycles,
      successes: this.successes,
      failures: this.failures,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
