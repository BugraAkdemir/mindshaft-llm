import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import type { EquipmentDestination } from 'mineflayer';
import { fail, ok, type ToolResult } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';
import { distance as dist, roundPoint, toPoint, type Point3 } from '../utils/spatial.js';
import type { MovementController } from './movement.js';
import type { GameRegistry } from './registry.js';

export const EQUIPMENT_DESTINATIONS = [
  'hand',
  'head',
  'torso',
  'legs',
  'feet',
  'off-hand',
] as const satisfies readonly EquipmentDestination[];

export interface CollectOutcome {
  collected: Array<{ item: string; count: number }>;
  remainingNearby: number;
}

/** Ranked from worst to best so tool upgrades are automatic. */
const TOOL_MATERIALS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'] as const;

/**
 * Inventory, equipment, eating and item pickup.
 *
 * Every entry point resolves item names through the registry first, so an
 * invented item name comes back as `UNKNOWN_ITEM` with suggestions instead of
 * throwing somewhere inside Mineflayer.
 */
export class InventoryManager {
  private readonly bot: Bot;
  private readonly registry: GameRegistry;
  private readonly movement: MovementController;
  private readonly log: Logger;

  public constructor(
    bot: Bot,
    registry: GameRegistry,
    movement: MovementController,
    logger?: Logger,
  ) {
    this.bot = bot;
    this.registry = registry;
    this.movement = movement;
    this.log = tagged('TOOL', logger);
  }

  /* ─────────────────────────────── lookups ────────────────────────────── */

  public findItem(rawName: string): Item | null {
    const name = this.registry.normalizeName(rawName);
    return this.bot.inventory.items().find((item) => item.name === name) ?? null;
  }

  public countItem(rawName: string): number {
    const name = this.registry.normalizeName(rawName);
    return this.bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((total, item) => total + item.count, 0);
  }

  public emptySlots(): number {
    return this.bot.inventory.emptySlotCount();
  }

  /* ──────────────────────────────── equip ─────────────────────────────── */

  public async equip(rawName: string, destination: EquipmentDestination): Promise<ToolResult> {
    const resolved = this.registry.resolveItem(rawName);
    if (!resolved) {
      const suggestions = this.registry.suggestItemNames(rawName);
      return fail(
        'UNKNOWN_ITEM',
        `"${rawName}" is not an item in Minecraft ${this.registry.version}.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
      );
    }

    const item = this.findItem(resolved.name);
    if (!item) {
      return fail(
        'ITEM_NOT_FOUND',
        `No ${resolved.name} in inventory. Carrying: ${this.summarize()}`,
      );
    }

    try {
      await this.bot.equip(item, destination);
      // Digging speed and scaffolding availability depend on what is held.
      this.movement.invalidateMovements();
      return ok({ equipped: resolved.name, destination });
    } catch (err) {
      return fail('MINEFLAYER_ERROR', `Could not equip ${resolved.name}: ${describeError(err)}`);
    }
  }

  /**
   * Equips the best available harvest tool for `block`, if any. Never fails the
   * caller — mining bare-handed is slow but legal.
   */
  public async equipBestToolFor(block: Block): Promise<string | null> {
    let best: Item | null = null;
    try {
      best = this.bot.pathfinder.bestHarvestTool(block);
    } catch (err) {
      this.log.debug({ err }, 'bestHarvestTool failed; falling back to name heuristics');
      best = this.guessToolFor(block);
    }
    best ??= this.guessToolFor(block);
    if (!best) return null;
    if (this.bot.heldItem?.name === best.name) return best.name;

    try {
      await this.bot.equip(best, 'hand');
      return best.name;
    } catch (err) {
      this.log.debug({ err }, `could not equip ${best.name}`);
      return null;
    }
  }

  /** Name-based fallback used when pathfinder's harvest-tool lookup is unavailable. */
  private guessToolFor(block: Block): Item | null {
    const kind = toolKindFor(block.name);
    if (!kind) return null;
    const candidates = this.bot.inventory.items().filter((item) => item.name.endsWith(`_${kind}`));
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => materialRank(b.name) - materialRank(a.name));
    return candidates[0] ?? null;
  }

  /* ───────────────────────────────── eat ──────────────────────────────── */

  /**
   * Eats the most appropriate food on hand. `preferred` is honoured when it is
   * both edible and present; otherwise the food closest to topping off the
   * hunger bar without wasting a golden apple is chosen.
   */
  public async eat(preferred?: string): Promise<ToolResult> {
    if (this.bot.food >= 20) {
      return fail('UNSAFE', 'Food bar is already full — eating now would waste the item.');
    }

    let chosen: Item | null = null;

    if (preferred) {
      const resolved = this.registry.resolveItem(preferred);
      if (!resolved) {
        return fail('UNKNOWN_ITEM', `"${preferred}" is not a known item.`);
      }
      if (!this.registry.isFood(resolved.name)) {
        return fail('NOT_EDIBLE', `${resolved.name} is not edible.`);
      }
      chosen = this.findItem(resolved.name);
      if (!chosen) {
        return fail('ITEM_NOT_FOUND', `No ${resolved.name} in inventory.`);
      }
    } else {
      chosen = this.bestFood();
      if (!chosen) {
        return fail(
          'ITEM_NOT_FOUND',
          `No edible items in inventory. Carrying: ${this.summarize()}`,
        );
      }
    }

    const foodBefore = this.bot.food;
    try {
      await this.bot.equip(chosen, 'hand');
      await this.bot.consume();
      return ok({
        ate: chosen.name,
        foodBefore,
        foodAfter: this.bot.food,
      });
    } catch (err) {
      // `consume` rejects when the server refuses the use action.
      return fail('MINEFLAYER_ERROR', `Could not eat ${chosen.name}: ${describeError(err)}`);
    }
  }

  /** Cheapest food that still helps; never picks an enchanted golden apple first. */
  public bestFood(): Item | null {
    const deficit = 20 - this.bot.food;
    const edible = this.bot.inventory
      .items()
      .filter((item) => this.registry.isFood(item.name))
      // Rotten flesh and spider eyes have side effects; keep them as a last resort.
      .map((item) => ({
        item,
        points: this.registry.foodPoints(item.name),
        risky: RISKY_FOODS.has(item.name),
        precious: PRECIOUS_FOODS.has(item.name),
      }));

    if (edible.length === 0) return null;

    edible.sort((a, b) => {
      if (a.risky !== b.risky) return a.risky ? 1 : -1;
      if (a.precious !== b.precious) return a.precious ? 1 : -1;
      // Prefer the smallest food that covers the deficit, else the largest.
      const aCovers = a.points >= deficit;
      const bCovers = b.points >= deficit;
      if (aCovers !== bCovers) return aCovers ? -1 : 1;
      return aCovers ? a.points - b.points : b.points - a.points;
    });

    return edible[0]?.item ?? null;
  }

  public hasFood(): boolean {
    return this.bestFood() !== null;
  }

  /* ─────────────────────────────── collect ────────────────────────────── */

  /**
   * Walks to nearby dropped items and picks them up. Pickup itself is automatic
   * in Minecraft — the work is getting within range of each stack in turn.
   */
  public async collect(
    options: { itemName?: string; radius: number; maxItems: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ToolResult<CollectOutcome>> {
    const wanted = options.itemName ? this.registry.normalizeName(options.itemName) : null;
    if (options.itemName && !this.registry.resolveItem(options.itemName)) {
      const suggestions = this.registry.suggestItemNames(options.itemName);
      return fail(
        'UNKNOWN_ITEM',
        `"${options.itemName}" is not a known item.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
      );
    }

    const deadline = Date.now() + options.timeoutMs;
    const collected: Array<{ item: string; count: number }> = [];
    const attempted = new Set<number>();

    for (let picked = 0; picked < options.maxItems; picked += 1) {
      if (options.signal?.aborted) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 500) break;

      const drops = this.nearbyDrops(options.radius, wanted).filter(
        (drop) => !attempted.has(drop.entity.id),
      );
      const target = drops[0];
      if (!target) break;

      attempted.add(target.entity.id);
      const before = this.countItem(target.name);

      const moveOptions = {
        range: 0.6,
        timeoutMs: Math.min(remainingMs, 12_000),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const move = await this.movement.moveTo(toPoint(target.entity.position), moveOptions);

      if (!move.success) {
        this.log.debug({ error: move.error }, `could not reach dropped ${target.name}`);
        continue;
      }

      // Give the server a moment to send the pickup packet.
      await this.bot.waitForTicks(6);

      const gained = this.countItem(target.name) - before;
      if (gained > 0) collected.push({ item: target.name, count: gained });
    }

    const remainingNearby = this.nearbyDrops(options.radius, wanted).length;

    if (collected.length === 0) {
      if (remainingNearby === 0) {
        return fail(
          'TARGET_NOT_FOUND',
          wanted
            ? `No dropped ${wanted} within ${options.radius} blocks.`
            : `No dropped items within ${options.radius} blocks.`,
        );
      }
      return fail(
        'PATH_NOT_FOUND',
        `Found ${remainingNearby} dropped stack(s) but could not reach any of them.`,
      );
    }

    return ok({ collected, remainingNearby });
  }

  /** Dropped-item entities within `radius`, nearest first. */
  public nearbyDrops(
    radius: number,
    itemName: string | null = null,
  ): Array<{ entity: Entity; name: string; count: number; distance: number; position: Point3 }> {
    const origin = toPoint(this.bot.entity.position);
    const drops: Array<{ entity: Entity; name: string; count: number; distance: number; position: Point3 }> = [];

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity?.position || entity.name !== 'item') continue;
      const d = dist(origin, toPoint(entity.position));
      if (d > radius) continue;

      let name = 'unknown';
      let count = 1;
      try {
        const item = entity.getDroppedItem();
        if (item) {
          name = item.name;
          count = item.count;
        }
      } catch {
        continue;
      }
      if (itemName && name !== itemName) continue;

      drops.push({ entity, name, count, distance: d, position: roundPoint(toPoint(entity.position), 1) });
    }

    drops.sort((a, b) => a.distance - b.distance);
    return drops;
  }

  /* ──────────────────────────────── misc ─────────────────────────────── */

  /** Compact inventory line used inside error messages. */
  public summarize(limit = 10): string {
    const items = this.bot.inventory.items();
    if (items.length === 0) return '(empty)';
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => `${name} x${count}`)
      .join(', ');
  }
}

/* ────────────────────────────── local helpers ─────────────────────────── */

const RISKY_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew']);
const PRECIOUS_FOODS = new Set(['golden_apple', 'enchanted_golden_apple', 'golden_carrot']);

function materialRank(itemName: string): number {
  for (const [index, material] of TOOL_MATERIALS.entries()) {
    if (itemName.startsWith(`${material}_`)) return index;
  }
  return -1;
}

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'shears';

/**
 * Ordered rules mapping a block to the tool family that harvests it fastest.
 *
 * Order is load-bearing: `hay_block` must match the hoe rule before any
 * `_block` pattern, and `sand` is anchored so `sandstone` still falls through to
 * the pickaxe rule.
 */
const TOOL_RULES: Array<{ kind: ToolKind; pattern: RegExp }> = [
  { kind: 'shears', pattern: /^(cobweb|vine|weeping_vines|twisting_vines|glow_lichen|seagrass|kelp|.*_wool|.*_leaves)$/ },
  {
    kind: 'hoe',
    pattern: /^(hay_block|sponge|wet_sponge|moss_block|moss_carpet|nether_wart_block|warped_wart_block|target|dried_kelp_block|shroomlight|sculk|sculk_vein)$/,
  },
  {
    kind: 'axe',
    pattern:
      /(_log$|_wood$|_stem$|_hyphae$|_planks$|_slab$|_stairs$|_fence$|_fence_gate$|_door$|_trapdoor$|_sign$|_boat$|^bamboo|^crafting_table$|^bookshelf$|^chest$|^trapped_chest$|^barrel$|^ladder$|^jukebox$|^note_block$|^loom$|^lectern$|^composter$|^cartography_table$|^fletching_table$|^smithing_table$|^beehive$|^bee_nest$|^melon$|^pumpkin$|^carved_pumpkin$|_mushroom_block$|^mushroom_stem$|campfire$)/,
  },
  {
    kind: 'shovel',
    pattern:
      /^(dirt|coarse_dirt|rooted_dirt|dirt_path|grass_block|podzol|mycelium|sand|red_sand|gravel|clay|soul_sand|soul_soil|snow|snow_block|powder_snow|farmland|mud|muddy_mangrove_roots|suspicious_sand|suspicious_gravel)$/,
  },
  {
    kind: 'pickaxe',
    pattern:
      /(_ore$|^ancient_debris$|stone|deepslate|granite|diorite|andesite|basalt|blackstone|obsidian|netherrack|brick|cobble|tuff|calcite|amethyst|terracotta|concrete|sandstone|dripstone|purpur|prismarine|quartz|^end_stone|rail$|^iron_|^gold_|^diamond_|^copper_|^redstone|^lapis|^emerald|^coal_block$|^netherite_block$|^bone_block$|^raw_(iron|gold|copper)_block$|^magma_block$|ice$|^furnace$|^blast_furnace$|^smoker$|^anvil$|^grindstone$|^stonecutter$|^bell$|^hopper$|cauldron$|^spawner$|^lodestone$|^respawn_anchor$|^enchanting_table$|^brewing_stand$|^beacon$|^conduit$|^shulker_box$|_shulker_box$)/,
  },
];

/** Maps a block name to the tool family that harvests it fastest. */
export function toolKindFor(blockName: string): ToolKind | null {
  const name = blockName.replace(/^minecraft:/, '');
  for (const rule of TOOL_RULES) {
    if (rule.pattern.test(name)) return rule.kind;
  }
  return null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
