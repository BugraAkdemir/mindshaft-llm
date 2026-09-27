import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import type { AgentConfig } from '../config/config.js';
import type {
  BlockGroup,
  EntityInfo,
  EnvironmentState,
  InventoryEntry,
  PlayerState,
  WorldState,
} from '../types.js';
import {
  describeRelative,
  distance as dist,
  floorPoint,
  roundPoint,
  round,
  toPoint,
  yawToDirection,
  type Point3,
} from '../utils/spatial.js';
import type { GameRegistry } from './registry.js';

/** Caps that keep a single observation small enough to prompt with. */
const MAX_BLOCK_GROUPS = 18;
const MAX_ENTITIES = 14;
const MAX_NEARBY_PLAYERS = 8;
const RARE_BLOCK_SCAN_LIMIT = 256;
const BULK_BLOCK_SCAN_LIMIT = 24;
const THREAT_RADIUS = 16;

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  utility: 1,
  resource: 2,
  bulk: 3,
};

const CATEGORY_RANK: Record<EntityInfo['category'], number> = {
  hostile: 0,
  player: 1,
  item: 2,
  villager: 3,
  passive: 4,
  other: 5,
};

/**
 * Turns the Mineflayer world into a compact, relevance-filtered snapshot.
 *
 * Three ideas do the heavy lifting:
 *  1. Only classified blocks are scanned at all (see `GameRegistry`).
 *  2. Identical blocks collapse into one group with a count and the nearest
 *     instance, so a forest costs one line instead of six hundred.
 *  3. Everything nearby carries a relative description (distance, compass
 *     direction, delta) because a text-only model reasons far better about
 *     "9 blocks north-east" than about a pair of absolute coordinates.
 */
export class WorldObserver {
  private readonly bot: Bot;
  private readonly registry: GameRegistry;
  private readonly cfg: AgentConfig;
  private tick = 0;
  private goalKeywordIds: number[] = [];
  /**
   * Supplies the enclosure check. Injected rather than duplicated so the
   * observer, the model and the reactive layer all agree on what "stuck" means.
   */
  private enclosureProbe: (() => { enclosed: boolean; blockedSides: number }) | null = null;

  public constructor(bot: Bot, registry: GameRegistry, cfg: AgentConfig) {
    this.bot = bot;
    this.registry = registry;
    this.cfg = cfg;
    this.setGoalKeywords(cfg.goal);
  }

  public setEnclosureProbe(probe: () => { enclosed: boolean; blockedSides: number }): void {
    this.enclosureProbe = probe;
  }

  /**
   * Extracts block-name keywords from the goal so goal-relevant blocks are
   * scanned even when they are not on the general interest list.
   */
  public setGoalKeywords(goal: string): void {
    const words = goal
      .toLowerCase()
      .split(/[^a-z_]+/)
      .filter((word) => word.length >= 4);
    const unique = [...new Set(words)];
    this.goalKeywordIds = this.registry.blockIdsMatching(unique).slice(0, 400);
  }

  public observe(): WorldState {
    this.tick += 1;
    const self = this.bot.entity;
    const origin = toPoint(self.position);

    const player = this.observePlayer();
    const environment = this.observeEnvironment(origin);
    const nearbyBlocks = this.observeBlocks(origin);
    const entities = this.observeEntities(origin);
    const inventory = this.observeInventory();

    const inventoryCounts: Record<string, number> = {};
    for (const entry of inventory) inventoryCounts[entry.item] = entry.count;

    const threats = entities.filter(
      (entity) => entity.category === 'hostile' && entity.distance <= THREAT_RADIUS,
    );

    const nearbyPlayers = entities
      .filter((entity) => entity.category === 'player')
      .slice(0, MAX_NEARBY_PLAYERS)
      .map((entity) => `${entity.name} (${entity.distance}m ${entity.direction})`);

    return {
      tick: this.tick,
      player,
      environment,
      nearbyBlocks,
      entities,
      inventory,
      inventoryCounts,
      nearbyPlayers,
      threats,
    };
  }

  /* ──────────────────────────────── player ────────────────────────────── */

  private observePlayer(): PlayerState {
    const bot = this.bot;
    const self = bot.entity;
    const feet = bot.blockAt(self.position);
    const eye = bot.blockAt(self.position.offset(0, 1, 0));
    const inWater = isLiquid(feet, 'water') || isLiquid(eye, 'water');

    return {
      position: roundPoint(toPoint(self.position), 2),
      velocity: roundPoint(toPoint(self.velocity), 2),
      health: round(bot.health ?? 0, 1),
      food: round(bot.food ?? 0, 1),
      oxygen: finiteOr(bot.oxygenLevel, 20),
      gamemode: bot.game?.gameMode ?? 'unknown',
      dimension: bot.game?.dimension ?? 'unknown',
      yaw: round(self.yaw, 2),
      pitch: round(self.pitch, 2),
      facing: yawToDirection(self.yaw),
      onGround: self.onGround,
      isInWater: inWater,
      heldItem: bot.heldItem?.name ?? null,
      equipment: this.observeEquipment(),
    };
  }

  private observeEquipment(): Record<string, string> {
    const equipment: Record<string, string> = {};
    const slots: Array<'head' | 'torso' | 'legs' | 'feet' | 'off-hand'> = [
      'head',
      'torso',
      'legs',
      'feet',
      'off-hand',
    ];
    for (const slot of slots) {
      try {
        const index = this.bot.getEquipmentDestSlot(slot);
        const item = this.bot.inventory.slots[index];
        if (item) equipment[slot] = item.name;
      } catch {
        // Older protocol versions lack an off-hand slot; skip silently.
      }
    }
    return equipment;
  }

  /* ───────────────────────────── environment ──────────────────────────── */

  private observeEnvironment(origin: Point3): EnvironmentState {
    const bot = this.bot;
    const head = bot.blockAt(new Vec3(origin.x, origin.y + 1, origin.z));
    const below = bot.blockAt(new Vec3(origin.x, origin.y - 1, origin.z));
    const timeOfDay = bot.time?.timeOfDay ?? 0;
    const enclosure = this.enclosureProbe?.() ?? { enclosed: false, blockedSides: 0 };

    return {
      time: timeOfDay,
      timeOfDay: describeTimeOfDay(timeOfDay),
      isDay: bot.time?.isDay ?? true,
      weather: bot.thunderState > 0 ? 'thunder' : bot.isRaining ? 'rain' : 'clear',
      lightLevel: Math.max(head?.light ?? 0, head?.skyLight ?? 0),
      biome: firstNonEmpty(head?.biome?.name, below?.biome?.name) ?? 'unknown',
      standingOn: below?.name ?? null,
      stuckInPit: enclosure.enclosed,
      blockedSides: enclosure.blockedSides,
    };
  }

  /* ─────────────────────────────── blocks ─────────────────────────────── */

  private observeBlocks(origin: Point3): BlockGroup[] {
    const radius = this.cfg.observationRadius;
    const { rare, bulk } = this.registry.observableBlockIds();

    const rareMatching = this.goalKeywordIds.length > 0 ? [...new Set([...rare, ...this.goalKeywordIds])] : rare;

    const positions: Vec3[] = [
      ...this.findBlocks(rareMatching, radius, RARE_BLOCK_SCAN_LIMIT),
      ...this.findBlocks(bulk, radius, BULK_BLOCK_SCAN_LIMIT),
    ];

    // Aggregate by block name, remembering only the closest instance.
    const groups = new Map<string, { count: number; nearest: Point3; distance: number }>();
    for (const position of positions) {
      const block = this.bot.blockAt(position);
      if (!block) continue;
      const point = floorPoint(toPoint(position));
      const d = dist(origin, { x: point.x + 0.5, y: point.y + 0.5, z: point.z + 0.5 });

      const existing = groups.get(block.name);
      if (existing === undefined) {
        groups.set(block.name, { count: 1, nearest: point, distance: d });
      } else {
        existing.count += 1;
        if (d < existing.distance) {
          existing.distance = d;
          existing.nearest = point;
        }
      }
    }

    const result: BlockGroup[] = [];
    for (const [type, group] of groups) {
      const spatial = describeRelative(origin, {
        x: group.nearest.x + 0.5,
        y: group.nearest.y + 0.5,
        z: group.nearest.z + 0.5,
      });
      result.push({
        type,
        count: group.count,
        nearest: group.nearest,
        distance: spatial.distance,
        direction: spatial.direction,
        relative: spatial.relative,
      });
    }

    // Critical hazards first, then utility, then resources, then bulk terrain;
    // within a tier, closest wins.
    result.sort((a, b) => {
      const rankA = PRIORITY_RANK[this.registry.blockPriority(a.type) ?? 'bulk'] ?? 3;
      const rankB = PRIORITY_RANK[this.registry.blockPriority(b.type) ?? 'bulk'] ?? 3;
      if (rankA !== rankB) return rankA - rankB;
      return a.distance - b.distance;
    });

    return result.slice(0, MAX_BLOCK_GROUPS);
  }

  private findBlocks(matching: number[], maxDistance: number, count: number): Vec3[] {
    if (matching.length === 0) return [];
    try {
      return this.bot.findBlocks({ matching, maxDistance, count });
    } catch {
      // findBlocks throws if chunks around the bot are not loaded yet.
      return [];
    }
  }

  /* ─────────────────────────────── entities ───────────────────────────── */

  private observeEntities(origin: Point3): EntityInfo[] {
    const radius = this.cfg.entityRadius;
    const selfId = this.bot.entity?.id;
    const infos: EntityInfo[] = [];

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity.id === selfId) continue;
      if (!entity.position) continue;

      const position = toPoint(entity.position);
      const d = dist(origin, position);
      if (d > radius) continue;

      const name = entity.username ?? entity.name ?? entity.displayName ?? 'unknown';
      const category = this.registry.classifyEntity(entity.name, entity.type);

      // Skip the noise: experience orbs, arrows in flight, etc.
      if (category === 'other' && !isInterestingOther(entity)) continue;

      const spatial = describeRelative(origin, position);
      const info: EntityInfo = {
        id: entity.id,
        type: entity.type ?? 'unknown',
        name,
        category,
        position: roundPoint(position, 1),
        distance: spatial.distance,
        direction: spatial.direction,
        relative: spatial.relative,
      };
      if (typeof entity.health === 'number') info.health = round(entity.health, 1);

      if (category === 'item') {
        const dropped = safeDroppedItem(entity);
        if (dropped) {
          info.itemName = dropped.name;
          info.itemCount = dropped.count;
        }
      }

      infos.push(info);
    }

    infos.sort((a, b) => {
      const rankA = CATEGORY_RANK[a.category];
      const rankB = CATEGORY_RANK[b.category];
      if (rankA !== rankB) return rankA - rankB;
      return a.distance - b.distance;
    });

    return infos.slice(0, MAX_ENTITIES);
  }

  /* ─────────────────────────────── inventory ──────────────────────────── */

  private observeInventory(): InventoryEntry[] {
    const grouped = new Map<string, InventoryEntry>();

    for (const item of this.bot.inventory.items()) {
      const existing = grouped.get(item.name);
      if (existing) {
        existing.count += item.count;
        existing.slots.push(item.slot);
        // Report the most-worn copy, which is the one that will break first.
        const durability = durabilityPercent(item);
        if (durability !== null && (existing.durability === undefined || durability < existing.durability)) {
          existing.durability = durability;
        }
        continue;
      }

      const entry: InventoryEntry = {
        item: item.name,
        count: item.count,
        slots: [item.slot],
      };
      const durability = durabilityPercent(item);
      if (durability !== null) entry.durability = durability;
      grouped.set(item.name, entry);
    }

    return [...grouped.values()].sort((a, b) => b.count - a.count || a.item.localeCompare(b.item));
  }
}

/* ────────────────────────────── local helpers ─────────────────────────── */

/**
 * Mineflayer can leave `oxygenLevel` undefined or NaN before the server reports
 * air supply, and `??` does not catch NaN.
 */
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Some servers report an empty biome name, which is not useful in a prompt. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

function durabilityPercent(item: { maxDurability?: number; durabilityUsed?: number }): number | null {
  const max = item.maxDurability;
  if (!max || max <= 0) return null;
  const used = item.durabilityUsed ?? 0;
  return Math.max(0, Math.round(((max - used) / max) * 100));
}

function isLiquid(block: Block | null, kind: 'water' | 'lava'): boolean {
  if (!block) return false;
  return block.name === kind || block.name === `flowing_${kind}` || (kind === 'water' && block.isWaterlogged === true);
}

/** Item frames, boats, minecarts and armour stands are worth mentioning. */
function isInterestingOther(entity: Entity): boolean {
  const name = entity.name ?? '';
  return ['boat', 'chest_boat', 'minecart', 'chest_minecart', 'armor_stand', 'item_frame'].some((kind) =>
    name.includes(kind),
  );
}

function safeDroppedItem(entity: Entity): { name: string; count: number } | null {
  try {
    const item = entity.getDroppedItem();
    if (!item) return null;
    return { name: item.name, count: item.count };
  } catch {
    return null;
  }
}

export function describeTimeOfDay(timeOfDay: number): string {
  const t = ((timeOfDay % 24_000) + 24_000) % 24_000;
  if (t < 1_000) return 'dawn';
  if (t < 5_000) return 'morning';
  if (t < 7_000) return 'noon';
  if (t < 11_000) return 'afternoon';
  if (t < 13_000) return 'dusk';
  if (t < 18_000) return 'night';
  if (t < 23_000) return 'late night';
  return 'dawn';
}
