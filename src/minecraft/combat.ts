import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import { fail, ok, type ToolResult } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';
import { distance as dist, round, roundPoint, toPoint, type Point3 } from '../utils/spatial.js';
import type { MovementController } from './movement.js';
import type { GameRegistry } from './registry.js';

/** Vanilla melee reach is 3 blocks; stay just inside it. */
const MELEE_REACH = 2.9;
const APPROACH_RANGE = 2.2;
/** Server-side attack cooldown; swinging faster does not increase damage. */
const SWING_INTERVAL_MS = 620;

const WEAPON_MATERIALS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'] as const;

export interface AttackOutcome {
  target: string;
  entityId: number;
  swings: number;
  killed: boolean;
  weapon: string | null;
  targetHealth: number | null;
}

export interface FleeOutcome {
  from: Point3;
  to: Point3;
  escapedFrom: string[];
  distanceGained: number;
}

/**
 * Melee combat and threat handling.
 *
 * Attacks are bounded by an explicit swing budget and deadline so a fight can
 * never become the infinite loop that stalls the whole agent.
 */
export class CombatController {
  private readonly bot: Bot;
  private readonly registry: GameRegistry;
  private readonly movement: MovementController;
  private readonly log: Logger;

  public constructor(bot: Bot, registry: GameRegistry, movement: MovementController, logger?: Logger) {
    this.bot = bot;
    this.registry = registry;
    this.movement = movement;
    this.log = tagged('TOOL', logger);
  }

  /* ──────────────────────────── target lookup ─────────────────────────── */

  /** Resolves either a numeric entity id or an entity name to a live entity. */
  public resolveTarget(ref: { entityId?: number; entityName?: string }, radius: number): Entity | null {
    if (ref.entityId !== undefined) {
      const entity = this.bot.entities[ref.entityId];
      if (entity?.isValid && entity.position) return entity;
      return null;
    }
    if (ref.entityName === undefined) return null;

    const wanted = this.registry.normalizeName(ref.entityName);
    const origin = toPoint(this.bot.entity.position);
    let best: { entity: Entity; distance: number } | null = null;

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity?.isValid || !entity.position || entity.id === this.bot.entity.id) continue;
      const name = this.registry.normalizeName(entity.name ?? entity.username ?? '');
      const username = entity.username ? this.registry.normalizeName(entity.username) : '';
      if (name !== wanted && username !== wanted) continue;

      const d = dist(origin, toPoint(entity.position));
      if (d > radius) continue;
      if (!best || d < best.distance) best = { entity, distance: d };
    }
    return best?.entity ?? null;
  }

  public nearestHostile(radius: number): Entity | null {
    const origin = toPoint(this.bot.entity.position);
    let best: { entity: Entity; distance: number } | null = null;

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity?.isValid || !entity.position) continue;
      if (this.registry.classifyEntity(entity.name, entity.type) !== 'hostile') continue;
      const d = dist(origin, toPoint(entity.position));
      if (d > radius) continue;
      if (!best || d < best.distance) best = { entity, distance: d };
    }
    return best?.entity ?? null;
  }

  public hostilesWithin(radius: number): Entity[] {
    const origin = toPoint(this.bot.entity.position);
    return Object.values(this.bot.entities)
      .filter(
        (entity): entity is Entity =>
          !!entity?.isValid &&
          !!entity.position &&
          this.registry.classifyEntity(entity.name, entity.type) === 'hostile' &&
          dist(origin, toPoint(entity.position)) <= radius,
      )
      .sort((a, b) => dist(origin, toPoint(a.position)) - dist(origin, toPoint(b.position)));
  }

  /* ─────────────────────────────── attacking ──────────────────────────── */

  public bestWeapon(): Item | null {
    const items = this.bot.inventory.items();
    let best: { item: Item; score: number } | null = null;

    for (const item of items) {
      let score = -1;
      if (item.name.endsWith('_sword')) score = 100 + weaponMaterialRank(item.name);
      else if (item.name.endsWith('_axe')) score = 50 + weaponMaterialRank(item.name);
      else if (item.name === 'trident') score = 140;
      if (score < 0) continue;
      if (!best || score > best.score) best = { item, score };
    }
    return best?.item ?? null;
  }

  public async equipBestWeapon(): Promise<string | null> {
    const weapon = this.bestWeapon();
    if (!weapon) return this.bot.heldItem?.name ?? null;
    if (this.bot.heldItem?.name === weapon.name) return weapon.name;
    try {
      await this.bot.equip(weapon, 'hand');
      return weapon.name;
    } catch (err) {
      this.log.debug({ err }, `could not equip weapon ${weapon.name}`);
      return this.bot.heldItem?.name ?? null;
    }
  }

  /**
   * Closes distance and swings until the target dies, the deadline passes, or
   * the swing budget is exhausted.
   */
  public async attack(
    target: Entity,
    options: { timeoutMs: number; maxSwings: number; signal?: AbortSignal },
  ): Promise<ToolResult<AttackOutcome>> {
    const startedAt = Date.now();
    const deadline = startedAt + options.timeoutMs;
    const name = target.username ?? target.name ?? 'entity';
    const entityId = target.id;

    const weapon = await this.equipBestWeapon();
    let swings = 0;

    while (swings < options.maxSwings) {
      if (options.signal?.aborted) {
        return fail('ABORTED', 'Attack cancelled by the safety layer.', Date.now() - startedAt);
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      const live = this.bot.entities[entityId];
      if (!live?.isValid || !live.position) {
        // Entity despawned or died between swings.
        return ok(
          { target: name, entityId, swings, killed: swings > 0, weapon, targetHealth: null },
          Date.now() - startedAt,
        );
      }

      const gap = dist(toPoint(this.bot.entity.position), toPoint(live.position));
      if (gap > MELEE_REACH) {
        const move = await this.movement.moveTo(toPoint(live.position), {
          range: APPROACH_RANGE,
          timeoutMs: Math.min(remainingMs, 10_000),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!move.success) {
          if (swings > 0) {
            return ok(
              {
                target: name,
                entityId,
                swings,
                killed: false,
                weapon,
                targetHealth: live.health ?? null,
              },
              Date.now() - startedAt,
            );
          }
          return fail(
            move.error,
            `Could not close on ${name}: ${move.details}`,
            Date.now() - startedAt,
          );
        }
        continue;
      }

      try {
        await this.bot.lookAt(live.position.offset(0, live.height * 0.7, 0), true);
        this.bot.attack(live);
        swings += 1;
      } catch (err) {
        return fail(
          'MINEFLAYER_ERROR',
          `Attack on ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
          Date.now() - startedAt,
        );
      }

      await this.bot.waitForTicks(Math.max(1, Math.round(SWING_INTERVAL_MS / 50)));
    }

    const survivor = this.bot.entities[entityId];
    const killed = !survivor?.isValid;
    const durationMs = Date.now() - startedAt;

    if (swings === 0) {
      return fail('TIMEOUT', `Never got within reach of ${name}.`, durationMs);
    }

    return ok(
      {
        target: name,
        entityId,
        swings,
        killed,
        weapon,
        targetHealth: survivor?.health ?? null,
      },
      durationMs,
    );
  }

  /* ──────────────────────────────── fleeing ───────────────────────────── */

  /**
   * Runs away from the given threats. Used by the reactive safety layer, which
   * must work without consulting the LLM.
   */
  public async flee(
    threats: Entity[],
    options: { minDistance: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ToolResult<FleeOutcome>> {
    const start = toPoint(this.bot.entity.position);
    if (threats.length === 0) {
      return fail('TARGET_NOT_FOUND', 'Nothing to flee from.');
    }

    // Average threat bearing, then head the opposite way.
    let sumX = 0;
    let sumZ = 0;
    for (const threat of threats) {
      sumX += threat.position.x - start.x;
      sumZ += threat.position.z - start.z;
    }
    const magnitude = Math.hypot(sumX, sumZ);
    // Threats stacked exactly on top of us give no bearing — pick an arbitrary one.
    const unitX = magnitude < 0.01 ? 1 : sumX / magnitude;
    const unitZ = magnitude < 0.01 ? 0 : sumZ / magnitude;

    const escapeDistance = Math.max(options.minDistance, 8);
    const candidates: Point3[] = [
      { x: start.x - unitX * escapeDistance, y: start.y, z: start.z - unitZ * escapeDistance },
      // Two flanking fallbacks in case the direct retreat is blocked.
      { x: start.x - unitZ * escapeDistance, y: start.y, z: start.z + unitX * escapeDistance },
      { x: start.x + unitZ * escapeDistance, y: start.y, z: start.z - unitX * escapeDistance },
    ];

    for (const candidate of candidates) {
      const move = await this.movement.moveTo(candidate, {
        range: 2,
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (move.success) {
        const end = toPoint(this.bot.entity.position);
        return ok({
          from: roundPoint(start, 1),
          to: roundPoint(end, 1),
          escapedFrom: threats.map((threat) => threat.name ?? 'unknown'),
          distanceGained: round(dist(start, end), 1),
        });
      }
    }

    return fail('PATH_NOT_FOUND', 'Could not find an escape route away from the threats.');
  }
}

function weaponMaterialRank(itemName: string): number {
  for (const [index, material] of WEAPON_MATERIALS.entries()) {
    if (itemName.startsWith(`${material}_`)) return index;
  }
  return 0;
}
