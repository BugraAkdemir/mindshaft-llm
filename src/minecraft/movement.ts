import type { Bot } from 'mineflayer';
// `mineflayer-pathfinder` is CommonJS, and Node's ESM named-export detection
// does not pick up the `goals` namespace — it is only reachable through the
// default (module.exports) binding.
import pathfinderPackage from 'mineflayer-pathfinder';
// The declaration file does export the types, so those still come in by name.
import type { Movements as MovementsInstance } from 'mineflayer-pathfinder';

const { goals, Movements } = pathfinderPackage;
import { Vec3 } from 'vec3';
import type { AgentConfig } from '../config/config.js';
import { fail, ok, type ToolResult } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';
import {
  distance as dist,
  horizontalDistance,
  isSaneCoordinate,
  round,
  roundPoint,
  toPoint,
  type Point3,
} from '../utils/spatial.js';

export interface MoveOptions {
  /** How close counts as "arrived". */
  range?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Aim to stand next to (and look at) the block rather than inside it. */
  adjacentToBlock?: boolean;
}

export interface MoveOutcome {
  from: Point3;
  to: Point3;
  finalDistance: number;
  travelled: number;
  durationMs: number;
}

/** Interval and threshold for the stuck detector. */
const PROGRESS_SAMPLE_MS = 500;
const PROGRESS_EPSILON = 0.12;
const STUCK_SAMPLES = 6; // ~3 seconds without meaningful movement

/**
 * High-level navigation. The LLM never presses keys — it names a destination and
 * this class owns path computation, arrival tolerance, stuck detection,
 * timeouts and cancellation, reporting every failure as a structured code.
 */
export class MovementController {
  private readonly bot: Bot;
  private readonly cfg: AgentConfig;
  private readonly log: Logger;
  private movements: MovementsInstance | null = null;
  private active = false;

  public constructor(bot: Bot, cfg: AgentConfig, logger?: Logger) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = tagged('TOOL', logger);

    this.bot.pathfinder.thinkTimeout = 5_000;
    this.bot.pathfinder.tickTimeout = 40;
  }

  public get isMoving(): boolean {
    return this.active || this.bot.pathfinder.isMoving();
  }

  /**
   * Movements depends on the inventory (scaffolding blocks, digging tools), so
   * it is rebuilt lazily and can be invalidated when the inventory changes.
   */
  public getMovements(): MovementsInstance {
    if (!this.movements) {
      const movements = new Movements(this.bot);
      movements.canDig = true;
      movements.allowParkour = true;
      movements.allowSprinting = true;
      movements.allow1by1towers = true;
      movements.canOpenDoors = true;
      // Never carve into a lava pool or tunnel under gravel while pathing.
      movements.dontCreateFlow = true;
      movements.dontMineUnderFallingBlock = true;
      movements.maxDropDown = 4;
      this.movements = movements;
    }
    return this.movements;
  }

  public invalidateMovements(): void {
    this.movements = null;
  }

  /** Cancels any in-flight path. Safe to call when nothing is moving. */
  public stop(): void {
    try {
      this.bot.pathfinder.stop();
      this.bot.pathfinder.setGoal(null);
    } catch (err) {
      this.log.debug({ err }, 'pathfinder stop failed (ignored)');
    }
    this.bot.clearControlStates();
    this.active = false;
  }

  public async moveTo(target: Point3, options: MoveOptions): Promise<ToolResult<MoveOutcome>> {
    const startedAt = Date.now();

    if (!isSaneCoordinate(target)) {
      return fail('UNSAFE', `Target ${JSON.stringify(target)} is outside the valid world bounds.`);
    }

    const from = toPoint(this.bot.entity.position);
    const requested = dist(from, target);
    if (requested > this.cfg.maxMoveDistance) {
      return fail(
        'TARGET_TOO_FAR',
        `Target is ${round(requested, 1)} blocks away, over the ${this.cfg.maxMoveDistance}-block per-move limit. ` +
          'Move in shorter hops toward it instead.',
      );
    }

    const range = clampRange(options.range, options.adjacentToBlock ? 2 : 1);

    if (requested <= range) {
      return ok(
        {
          from: roundPoint(from, 2),
          to: roundPoint(from, 2),
          finalDistance: round(requested, 2),
          travelled: 0,
          durationMs: Date.now() - startedAt,
        },
        Date.now() - startedAt,
      );
    }

    // Serialize: a second concurrent goto would abort the first with
    // GoalChanged and produce a confusing failure for the previous caller.
    if (this.isMoving) this.stop();

    const goal = options.adjacentToBlock
      ? new goals.GoalGetToBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))
      : new goals.GoalNear(target.x, target.y, target.z, range);

    this.bot.pathfinder.setMovements(this.getMovements());
    this.active = true;

    const watchdog = this.startWatchdog(options);

    try {
      await Promise.race([this.bot.pathfinder.goto(goal), watchdog.promise]);

      const to = toPoint(this.bot.entity.position);
      const finalDistance = dist(to, target);
      const durationMs = Date.now() - startedAt;
      return ok(
        {
          from: roundPoint(from, 2),
          to: roundPoint(to, 2),
          finalDistance: round(finalDistance, 2),
          travelled: round(dist(from, to), 2),
          durationMs,
        },
        durationMs,
      );
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.stop();
      return this.toFailure(err, target, durationMs);
    } finally {
      watchdog.cancel();
      this.active = false;
    }
  }

  /** Pathfinds to within reach of a block so it can be mined or interacted with. */
  public async moveToBlock(
    position: Point3,
    options: Omit<MoveOptions, 'adjacentToBlock'> & { reach?: number },
  ): Promise<ToolResult<MoveOutcome>> {
    const reach = clampRange(options.reach, 3);
    const blockCentre = { x: Math.floor(position.x) + 0.5, y: Math.floor(position.y) + 0.5, z: Math.floor(position.z) + 0.5 };
    const moveOptions: MoveOptions = { range: reach, timeoutMs: options.timeoutMs };
    if (options.signal) moveOptions.signal = options.signal;
    return this.moveTo(blockCentre, moveOptions);
  }

  /**
   * Rejects when the move times out, is aborted, or stops making progress.
   * Returns a cancel handle so the timer never outlives a successful path.
   */
  private startWatchdog(options: MoveOptions): { promise: Promise<never>; cancel: () => void } {
    let timeoutTimer: NodeJS.Timeout | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const promise = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new MovementTimeout(options.timeoutMs));
      }, options.timeoutMs);

      let stalled = 0;
      let last = toPoint(this.bot.entity.position);
      progressTimer = setInterval(() => {
        const current = toPoint(this.bot.entity.position);
        const moved = horizontalDistance(current, last) + Math.abs(current.y - last.y);
        last = current;

        // Mining or placing scaffolding legitimately keeps the bot still.
        const busy = this.bot.pathfinder.isMining() || this.bot.pathfinder.isBuilding();
        stalled = moved < PROGRESS_EPSILON && !busy ? stalled + 1 : 0;

        if (stalled >= STUCK_SAMPLES) {
          reject(new MovementStuck(PROGRESS_SAMPLE_MS * stalled));
        }
      }, PROGRESS_SAMPLE_MS);

      if (options.signal) {
        if (options.signal.aborted) {
          reject(new MovementAborted());
          return;
        }
        onAbort = (): void => reject(new MovementAborted());
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    // Prevent an unhandled rejection if the race is won by `goto`.
    promise.catch(() => undefined);

    return {
      promise,
      cancel: () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (progressTimer) clearInterval(progressTimer);
        if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);
      },
    };
  }

  private toFailure(err: unknown, target: Point3, durationMs: number): ToolResult<MoveOutcome> {
    const position = roundPoint(toPoint(this.bot.entity.position), 1);
    const remaining = round(dist(position, target), 1);

    if (err instanceof MovementTimeout) {
      return fail(
        'PATH_TIMEOUT',
        `Movement timed out after ${err.timeoutMs}ms; stopped at ${formatVec(position)}, still ${remaining} blocks from the target.`,
        durationMs,
      );
    }
    if (err instanceof MovementStuck) {
      return fail(
        'PATH_INTERRUPTED',
        `Stuck at ${formatVec(position)} for ${err.stalledMs}ms with ${remaining} blocks to go. ` +
          'Try a closer waypoint, a different approach, or mine the obstruction.',
        durationMs,
      );
    }
    if (err instanceof MovementAborted) {
      return fail('ABORTED', 'Movement was cancelled by the safety layer or shutdown.', durationMs);
    }

    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);

    switch (name) {
      case 'NoPath':
        return fail(
          'PATH_NOT_FOUND',
          `No reachable path to ${formatVec(target)} from ${formatVec(position)}. The target may be enclosed, ` +
            'across a gap, or too high — pick an intermediate waypoint.',
          durationMs,
        );
      case 'Timeout':
        return fail(
          'PATH_TIMEOUT',
          `Pathfinder could not compute a route to ${formatVec(target)} in time.`,
          durationMs,
        );
      case 'GoalChanged':
      case 'PathStopped':
        return fail(
          'PATH_INTERRUPTED',
          `Path to ${formatVec(target)} was interrupted (${name}); stopped at ${formatVec(position)}.`,
          durationMs,
        );
      default:
        return fail('MINEFLAYER_ERROR', `Movement failed: ${message}`, durationMs);
    }
  }
}

class MovementTimeout extends Error {
  public override readonly name = 'MovementTimeout';
  public constructor(public readonly timeoutMs: number) {
    super(`movement timed out after ${timeoutMs}ms`);
  }
}

class MovementStuck extends Error {
  public override readonly name = 'MovementStuck';
  public constructor(public readonly stalledMs: number) {
    super(`no progress for ${stalledMs}ms`);
  }
}

class MovementAborted extends Error {
  public override readonly name = 'MovementAborted';
  public constructor() {
    super('movement aborted');
  }
}

function clampRange(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 16);
}

function formatVec(p: Point3): string {
  return `(${round(p.x, 1)}, ${round(p.y, 1)}, ${round(p.z, 1)})`;
}

export function toVector(p: Point3): Vec3 {
  return new Vec3(p.x, p.y, p.z);
}
