import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import type { AgentConfig } from '../config/config.js';
import { tagged, type Logger } from '../utils/logger.js';
import { distance as dist, round, toPoint, type Point3 } from '../utils/spatial.js';
import type { CombatController } from './combat.js';
import type { InventoryManager } from './inventory.js';
import type { MovementController } from './movement.js';

export type SafetyAction =
  | 'none'
  | 'fled_low_health'
  | 'ate_food'
  | 'stopped_at_lava'
  | 'interrupted_for_threat'
  | 'surfaced_for_air'
  | 'suffocating_in_block'
  | 'escaped_pit';

export interface SafetyReport {
  action: SafetyAction;
  detail: string;
}

/** How often the tick handler is allowed to do real work. */
const CHECK_INTERVAL_TICKS = 5;
/** A hostile inside this radius interrupts long-running LLM actions. */
const INTERRUPT_RADIUS = 5;
/** Lava/fire within this distance stops movement immediately. */
const LAVA_DANGER_DISTANCE = 2.2;
/**
 * How long the bot may sit boxed in and motionless before the safety layer
 * builds its own way out. Long enough that the model gets first refusal, short
 * enough that a run does not silently stall forever.
 */
const PIT_ESCAPE_AFTER_MS = 20_000;
/** Movement under this counts as "not moving" for pit detection. */
const PIT_IDLE_EPSILON = 0.6;

/**
 * Deterministic survival reflexes.
 *
 * The LLM decides *strategy* on a multi-second cycle, which is far too slow to
 * survive a creeper at point-blank range. This layer runs on the physics tick,
 * never calls the model, and only does things that are unambiguously correct:
 * stop walking into lava, eat when starving, break off an action when a mob is
 * on top of us, and run when nearly dead.
 *
 * It is a safety net, not gameplay scripting — it never chooses what to build,
 * mine, or craft.
 */
export class ReactiveSafety {
  private readonly bot: Bot;
  private readonly cfg: AgentConfig;
  private readonly movement: MovementController;
  private readonly combat: CombatController;
  private readonly inventory: InventoryManager;
  private readonly log: Logger;
  /** Set by the agent once BlockActions exists; without it pit escape is off. */
  private pitEscape: {
    isEnclosed: () => boolean;
    climbOut: (height: number) => Promise<boolean>;
  } | null = null;

  private tickCounter = 0;
  private attached = false;
  /** True while an async reflex is running, so reflexes never overlap. */
  private busy = false;
  private lastReport: SafetyReport = { action: 'none', detail: '' };
  private interruptController: AbortController | null = null;
  private lastEatAttempt = 0;
  private lastFleeAttempt = 0;
  private lastPitEscape = 0;
  /** Position sampling used to notice the bot has stopped getting anywhere. */
  private idleSince = Date.now();
  private idleAnchor: Point3 | null = null;

  public constructor(
    bot: Bot,
    cfg: AgentConfig,
    movement: MovementController,
    combat: CombatController,
    inventory: InventoryManager,
    logger?: Logger,
  ) {
    this.bot = bot;
    this.cfg = cfg;
    this.movement = movement;
    this.combat = combat;
    this.inventory = inventory;
    this.log = tagged('SAFETY', logger);
  }

  /**
   * Supplies the pit-escape capability. Kept as an injected hook because
   * `BlockActions` depends on the inventory and movement layers, which would
   * otherwise make this a circular dependency.
   */
  public setPitEscape(hooks: {
    isEnclosed: () => boolean;
    climbOut: (height: number) => Promise<boolean>;
  }): void {
    this.pitEscape = hooks;
  }

  public attach(): void {
    if (!this.cfg.reactiveSafety || this.attached) return;
    this.attached = true;
    this.bot.on('physicsTick', this.onTick);
    this.log.debug('reactive safety layer attached');
  }

  public detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.bot.removeListener('physicsTick', this.onTick);
  }

  /**
   * Signal handed to every tool execution. The safety layer aborts it when an
   * emergency needs to pre-empt a long-running action.
   */
  public createActionSignal(): AbortSignal {
    this.interruptController?.abort();
    this.interruptController = new AbortController();
    return this.interruptController.signal;
  }

  public clearActionSignal(): void {
    this.interruptController = null;
  }

  public consumeReport(): SafetyReport {
    const report = this.lastReport;
    this.lastReport = { action: 'none', detail: '' };
    return report;
  }

  /**
   * Oxygen as a 0-20 value.
   *
   * Mineflayer derives this from entity metadata and leaves it `undefined` until
   * the server first reports air supply; a metadata bundle without the field can
   * even make it `NaN`, which `??` does not catch. Treat anything non-finite as
   * "full", since the bot is not drowning until told otherwise.
   */
  private oxygen(): number {
    const value = this.bot.oxygenLevel;
    return typeof value === 'number' && Number.isFinite(value) ? value : 20;
  }

  /** True when the situation is dangerous enough that the agent should react. */
  public isInDanger(): boolean {
    const health = this.bot.health ?? 20;
    if (health <= this.cfg.panicHealth) return true;
    if (this.nearestLavaDistance() <= LAVA_DANGER_DISTANCE) return true;
    return this.combat.hostilesWithin(INTERRUPT_RADIUS).length > 0;
  }

  /* ─────────────────────────────── tick loop ──────────────────────────── */

  private onTick = (): void => {
    this.tickCounter += 1;
    if (this.tickCounter % CHECK_INTERVAL_TICKS !== 0) return;
    if (this.busy) return;
    if (!this.bot.entity) return;

    // Cheap synchronous guards first — these must not wait on a promise.
    if (this.guardLava()) return;

    const health = this.bot.health ?? 20;
    const now = Date.now();

    // Critically hurt: break off whatever we were doing and run.
    if (health <= this.cfg.criticalHealth && now - this.lastFleeAttempt > 4_000) {
      this.lastFleeAttempt = now;
      void this.runReflex('fled_low_health', async () => {
        const threats = this.combat.hostilesWithin(12);
        this.interrupt('health critical');

        if (threats.length === 0) {
          // Nothing to run from — the damage is environmental (fall, fire, drowning).
          this.movement.stop();
          return `Health ${round(health, 1)}/20 with no hostile nearby; stopped moving.`;
        }

        const result = await this.combat.flee(threats, { minDistance: 14, timeoutMs: 8_000 });
        return result.success
          ? `Health ${round(health, 1)}/20 — fled ${result.data.distanceGained} blocks from ${result.data.escapedFrom.join(', ')}.`
          : `Health ${round(health, 1)}/20 — could not escape (${result.details}).`;
      });
      return;
    }

    // Starving, or hungry enough that regeneration has stopped.
    if (
      this.bot.food <= this.cfg.autoEatFoodLevel &&
      this.inventory.hasFood() &&
      now - this.lastEatAttempt > 6_000
    ) {
      this.lastEatAttempt = now;
      void this.runReflex('ate_food', async () => {
        const result = await this.inventory.eat();
        return result.success
          ? `Ate automatically (food ${this.bot.food}/20).`
          : `Auto-eat failed: ${result.details}`;
      });
      return;
    }

    // Losing air. Two very different causes need two different responses, and
    // conflating them means holding jump forever against a block of leaves.
    const oxygen = this.oxygen();
    if (oxygen <= 6) {
      const head = this.bot.blockAt(this.bot.entity.position.offset(0, 1, 0));
      const headName = head?.name ?? 'air';
      const inWater = headName === 'water' || headName === 'flowing_water' || head?.isWaterlogged === true;

      if (inWater) {
        this.report('surfaced_for_air', `Oxygen ${oxygen}/20 underwater — swimming up.`);
        this.bot.setControlState('jump', true);
        return;
      }

      if (head !== null && head.boundingBox === 'block') {
        // Head inside a solid block: vanilla calls this suffocation. Jumping
        // does not help, so stop fighting the current action and let the agent
        // mine its way out — it is told which block is doing it.
        this.bot.setControlState('jump', false);
        this.report(
          'suffocating_in_block',
          `Suffocating: your head is inside ${headName} (oxygen ${oxygen}/20). ` +
            `Mine the ${headName} above you, or move out of it.`,
        );
        return;
      }
    }

    // Recovered, or never really drowning: stop holding jump.
    if (this.bot.getControlState('jump') && oxygen > 12) {
      this.bot.setControlState('jump', false);
    }

    // Boxed in and going nowhere: dig-straight-down is the classic way a bot
    // strands itself, and no amount of pathfinding gets it out.
    if (this.checkPit(now)) return;

    // A mob at point-blank range while we are mid-action: let the agent re-plan.
    const closeThreats = this.combat.hostilesWithin(INTERRUPT_RADIUS);
    if (closeThreats.length > 0 && health <= this.cfg.panicHealth) {
      const names = closeThreats.map((threat) => threat.name ?? 'hostile').join(', ');
      this.interrupt(`hostile within ${INTERRUPT_RADIUS} blocks: ${names}`);
      this.report('interrupted_for_threat', `Interrupted current action — ${names} at close range.`);
    }
  };

  /**
   * Notices a bot that is walled in and has not moved for a while, then builds
   * it a staircase out. Returns true when an escape was started.
   */
  private checkPit(now: number): boolean {
    if (!this.pitEscape) return false;

    const position = toPoint(this.bot.entity.position);
    if (this.idleAnchor === null || dist(this.idleAnchor, position) > PIT_IDLE_EPSILON) {
      this.idleAnchor = position;
      this.idleSince = now;
      return false;
    }

    // Moving under its own power, or mid-path: not stranded.
    if (this.movement.isMoving) {
      this.idleSince = now;
      return false;
    }
    if (now - this.idleSince < PIT_ESCAPE_AFTER_MS) return false;
    if (now - this.lastPitEscape < PIT_ESCAPE_AFTER_MS) return false;
    if (!this.pitEscape.isEnclosed()) return false;

    this.lastPitEscape = now;
    this.idleSince = now;

    void this.runReflex('escaped_pit', async () => {
      const escaped = await this.pitEscape!.climbOut(3);
      return escaped
        ? 'Was walled in and idle; built a pillar to climb out.'
        : 'Was walled in and idle, but could not build a way out (no blocks to place?).';
    });
    return true;
  }

  /**
   * Stops movement when lava or fire is dangerously close. Synchronous on
   * purpose: by the time a promise resolves the bot is already burning.
   */
  private guardLava(): boolean {
    if (!this.movement.isMoving) return false;
    const distance = this.nearestLavaDistance();
    if (distance > LAVA_DANGER_DISTANCE) return false;

    this.movement.stop();
    this.interrupt('lava within reach');
    this.report('stopped_at_lava', `Lava ${round(distance, 1)} blocks away — movement halted.`);
    return true;
  }

  /** Scans the 5x3x5 neighbourhood for lava or fire. */
  private nearestLavaDistance(): number {
    const origin = this.bot.entity?.position;
    if (!origin) return Number.POSITIVE_INFINITY;
    const centre = toPoint(origin);
    let nearest = Number.POSITIVE_INFINITY;

    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
          const block = this.bot.blockAt(new Vec3(origin.x + dx, origin.y + dy, origin.z + dz));
          if (!block) continue;
          if (block.name !== 'lava' && block.name !== 'flowing_lava' && block.name !== 'fire' && block.name !== 'soul_fire') {
            continue;
          }
          const d = dist(centre, {
            x: block.position.x + 0.5,
            y: block.position.y + 0.5,
            z: block.position.z + 0.5,
          });
          if (d < nearest) nearest = d;
        }
      }
    }
    return nearest;
  }

  /* ───────────────────────────── plumbing ─────────────────────────────── */

  /** Runs an async reflex under the `busy` lock so two cannot overlap. */
  private async runReflex(action: SafetyAction, body: () => Promise<string>): Promise<void> {
    this.busy = true;
    try {
      const detail = await body();
      this.report(action, detail);
    } catch (err) {
      this.log.warn({ err }, `reflex ${action} failed`);
    } finally {
      this.busy = false;
    }
  }

  private interrupt(reason: string): void {
    if (!this.interruptController || this.interruptController.signal.aborted) return;
    this.log.warn(`interrupting current action: ${reason}`);
    this.interruptController.abort();
  }

  private report(action: SafetyAction, detail: string): void {
    this.lastReport = { action, detail };
    this.log.info(detail);
  }
}
