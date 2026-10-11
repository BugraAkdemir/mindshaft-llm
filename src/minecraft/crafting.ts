import type { Bot, Furnace } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Recipe } from 'prismarine-recipe';
import { fail, ok, type ToolResult } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';
import { distance as dist, toPoint, type Point3 } from '../utils/spatial.js';
import type { InventoryManager } from './inventory.js';
import type { MovementController } from './movement.js';
import type { GameRegistry } from './registry.js';

const FURNACE_BLOCKS = ['furnace', 'blast_furnace', 'smoker'] as const;
const INTERACT_REACH = 4.0;

/** How often to re-read the inventory while waiting for a craft to be credited. */
const CRAFT_SETTLE_POLL_MS = 25;

/** Upper bound on that wait — long enough for a slow server, short enough to fail fast. */
const CRAFT_SETTLE_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Items smelted per unit of fuel. Fuel burn times are not part of
 * minecraft-data, so the common fuels are tabulated here; anything not listed
 * is simply not offered to the furnace.
 */
const FUEL_VALUES: Array<{ match: (name: string) => boolean; itemsPerUnit: number }> = [
  { match: (n) => n === 'lava_bucket', itemsPerUnit: 100 },
  { match: (n) => n === 'coal_block', itemsPerUnit: 80 },
  { match: (n) => n === 'dried_kelp_block', itemsPerUnit: 20 },
  { match: (n) => n === 'blaze_rod', itemsPerUnit: 12 },
  { match: (n) => n === 'coal' || n === 'charcoal', itemsPerUnit: 8 },
  { match: (n) => n === 'bamboo_block', itemsPerUnit: 4.5 },
  { match: (n) => n.endsWith('_boat') || n.endsWith('_chest_boat'), itemsPerUnit: 6 },
  { match: (n) => n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_stem') || n.endsWith('_hyphae'), itemsPerUnit: 1.5 },
  { match: (n) => n.endsWith('_planks') || n.endsWith('_slab') || n.endsWith('_stairs') || n.endsWith('_fence'), itemsPerUnit: 1.5 },
  { match: (n) => n === 'stick' || n === 'bamboo', itemsPerUnit: 0.5 },
  { match: (n) => n === 'bowl' || n === 'crafting_table' || n === 'bookshelf' || n === 'ladder', itemsPerUnit: 1.5 },
];

/**
 * Well-known furnace recipes. Smelting is not represented in
 * minecraft-data's recipe index, so this table supplies the expected output for
 * the common cases. Unlisted inputs are still attempted — the furnace itself is
 * the authority, and `NO_RECIPE` is only reported if nothing comes out.
 */
const SMELTING_RECIPES: Record<string, string> = {
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  raw_copper: 'copper_ingot',
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  nether_gold_ore: 'gold_ingot',
  ancient_debris: 'netherite_scrap',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz',
  sand: 'glass',
  red_sand: 'glass',
  cobblestone: 'stone',
  cobbled_deepslate: 'deepslate',
  stone: 'smooth_stone',
  sandstone: 'smooth_sandstone',
  red_sandstone: 'smooth_red_sandstone',
  quartz_block: 'smooth_quartz',
  clay_ball: 'brick',
  clay: 'terracotta',
  netherrack: 'nether_brick',
  cactus: 'green_dye',
  sea_pickle: 'lime_dye',
  chorus_fruit: 'popped_chorus_fruit',
  wet_sponge: 'sponge',
  kelp: 'dried_kelp',
  potato: 'baked_potato',
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  oak_log: 'charcoal',
  spruce_log: 'charcoal',
  birch_log: 'charcoal',
  jungle_log: 'charcoal',
  acacia_log: 'charcoal',
  dark_oak_log: 'charcoal',
  mangrove_log: 'charcoal',
  cherry_log: 'charcoal',
  pale_oak_log: 'charcoal',
};

export interface CraftOutcome {
  item: string;
  requested: number;
  produced: number;
  usedCraftingTable: boolean;
  tablePosition?: Point3;
  consumed: Array<{ item: string; count: number }>;
}

export interface SmeltOutcome {
  input: string;
  output: string;
  count: number;
  fuel: string;
  furnace: string;
  furnacePosition: Point3;
}

/**
 * Crafting and smelting.
 *
 * Both paths fully validate before acting: an unknown item, a missing recipe,
 * missing ingredients, a missing crafting table and missing fuel are each a
 * distinct structured error, so the model can actually fix its plan.
 */
export class CraftingManager {
  private readonly bot: Bot;
  private readonly registry: GameRegistry;
  private readonly movement: MovementController;
  private readonly inventory: InventoryManager;
  private readonly log: Logger;

  public constructor(
    bot: Bot,
    registry: GameRegistry,
    movement: MovementController,
    inventory: InventoryManager,
    logger?: Logger,
  ) {
    this.bot = bot;
    this.registry = registry;
    this.movement = movement;
    this.inventory = inventory;
    this.log = tagged('TOOL', logger);
  }

  /* ─────────────────────────────── crafting ───────────────────────────── */

  public async craft(
    rawItemName: string,
    count: number,
    options: { searchRadius: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ToolResult<CraftOutcome>> {
    const startedAt = Date.now();

    const resolved = this.registry.resolveItem(rawItemName);
    if (!resolved) {
      const suggestions = this.registry.suggestItemNames(rawItemName);
      return fail(
        'UNKNOWN_ITEM',
        `"${rawItemName}" is not an item in Minecraft ${this.registry.version}.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
      );
    }

    // Prefer a recipe that needs no table, so the agent is not blocked early on.
    let recipe = this.bot.recipesFor(resolved.id, null, count, null)[0];
    let table: Block | null = null;

    if (!recipe) {
      table = this.findNearestBlock(['crafting_table'], options.searchRadius);
      recipe = this.bot.recipesFor(resolved.id, null, count, table ?? true)[0];

      if (recipe && !table) {
        // A recipe exists but needs a table we do not have in range.
        return fail(
          'CRAFTING_TABLE_REQUIRED',
          `Crafting ${resolved.name} needs a crafting table and none is within ${options.searchRadius} blocks. ` +
            (this.inventory.findItem('crafting_table')
              ? 'You are carrying one — place it first with place_block.'
              : 'Craft one from 4 planks first.'),
          Date.now() - startedAt,
        );
      }
    }

    if (!recipe) {
      const missing = this.describeMissingIngredients(resolved.id, count, table);
      if (missing) {
        return fail('MISSING_INGREDIENTS', missing, Date.now() - startedAt);
      }
      return fail(
        'NO_RECIPE',
        `No crafting recipe produces ${resolved.name}${table ? '' : ' (with or without a crafting table)'}. ` +
          'It may need smelting, smithing, or to be found in the world.',
        Date.now() - startedAt,
      );
    }

    if (recipe.requiresTable && !table) {
      table = this.findNearestBlock(['crafting_table'], options.searchRadius);
      if (!table) {
        return fail(
          'CRAFTING_TABLE_REQUIRED',
          `Crafting ${resolved.name} needs a crafting table within reach.`,
          Date.now() - startedAt,
        );
      }
    }

    // Walk to the table before opening it.
    if (table) {
      const approach = await this.approachBlock(table, options.timeoutMs, options.signal);
      if (approach) return approach;
      // Re-read: someone may have broken the table while we walked.
      const live = this.bot.blockAt(table.position);
      if (!live || live.name !== 'crafting_table') {
        return fail(
          'CRAFTING_TABLE_REQUIRED',
          `The crafting table at (${table.position.x}, ${table.position.y}, ${table.position.z}) is gone.`,
          Date.now() - startedAt,
        );
      }
      table = live;
    }

    const resultPerCraft = recipe.result.count || 1;
    const crafts = Math.max(1, Math.ceil(count / resultPerCraft));
    const before = this.snapshot();

    try {
      // One craft per call, with a beat between them. Handing Mineflayer the
      // whole batch at once desyncs the 2x2 inventory grid: the ingredient
      // stack ends up stranded on the cursor instead of being consumed, so
      // every log that was meant to become planks silently disappears.
      for (let i = 0; i < crafts; i += 1) {
        await this.bot.craft(recipe, 1, table ?? undefined);
        if (i < crafts - 1) await this.bot.waitForTicks(2);
      }
    } catch (err) {
      return fail(
        'MINEFLAYER_ERROR',
        `Crafting ${resolved.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - startedAt,
      );
    }

    // The server credits the result asynchronously, and `craft()` resolves
    // before that confirmation lands. A fixed settle races it: the snapshot
    // then shows no change, the craft is reported as a failure, and the
    // agent's retry spends a second set of ingredients on a craft that
    // already happened. Poll for the real inventory change instead, but cap
    // the wait well short of the action budget so a craft that genuinely
    // produced nothing still fails fast with a readable message.
    const settleDeadline = Math.min(startedAt + options.timeoutMs, Date.now() + CRAFT_SETTLE_MAX_MS);
    let after = this.snapshot();
    let produced = (after.get(resolved.name) ?? 0) - (before.get(resolved.name) ?? 0);
    while (produced <= 0 && Date.now() < settleDeadline) {
      await this.bot.waitForTicks(2);
      await sleep(CRAFT_SETTLE_POLL_MS);
      after = this.snapshot();
      produced = (after.get(resolved.name) ?? 0) - (before.get(resolved.name) ?? 0);
    }
    const consumed: Array<{ item: string; count: number }> = [];
    for (const [name, quantity] of before) {
      const lost = quantity - (after.get(name) ?? 0);
      if (lost > 0) consumed.push({ item: name, count: lost });
    }

    this.movement.invalidateMovements();

    if (produced <= 0) {
      return fail(
        'MINEFLAYER_ERROR',
        `Crafting ${resolved.name} reported success but the inventory did not change.`,
        Date.now() - startedAt,
      );
    }

    const outcome: CraftOutcome = {
      item: resolved.name,
      requested: count,
      produced,
      usedCraftingTable: table !== null,
      consumed,
    };
    if (table) outcome.tablePosition = toPoint(table.position);

    return ok(outcome, Date.now() - startedAt);
  }

  /**
   * Human-readable "you need N more x" message derived from the recipe delta.
   *
   * Many items have one recipe per material (every wood type, every stone
   * type), so with a bare inventory several variants are exactly equally far
   * away. Rather than picking one arbitrarily — which once told the agent to go
   * find *cherry* planks — interchangeable materials are reported as a choice.
   */
  private describeMissingIngredients(itemId: number, count: number, table: Block | null): string | null {
    const all = this.bot.recipesAll(itemId, null, table ?? true);
    if (all.length === 0) return null;

    interface Candidate {
      /** Missing ingredient name -> units still required. */
      missing: Map<string, number>;
      /** Total units still required across all ingredients. */
      shortfall: number;
      /** Units of the needed ingredients already held; higher is closer to done. */
      progress: number;
    }

    const candidates: Candidate[] = [];

    for (const recipe of all) {
      const crafts = Math.max(1, Math.ceil(count / (recipe.result.count || 1)));
      const missing = new Map<string, number>();
      let shortfall = 0;
      let progress = 0;

      for (const delta of recipe.delta) {
        if (delta.count >= 0) continue;
        const required = -delta.count * crafts;
        const have = this.bot.inventory.count(delta.id, delta.metadata);
        progress += Math.min(have, required);

        if (have < required) {
          const name = this.registry.data.items[delta.id]?.name ?? `item:${delta.id}`;
          const need = required - have;
          missing.set(name, (missing.get(name) ?? 0) + need);
          shortfall += need;
        }
      }
      if (missing.size === 0) continue;
      candidates.push({ missing, shortfall, progress });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (a.missing.size !== b.missing.size) return a.missing.size - b.missing.size;
      if (a.shortfall !== b.shortfall) return a.shortfall - b.shortfall;
      return b.progress - a.progress;
    });

    const best = candidates[0]!;
    // Every recipe that is exactly as close counts as a real alternative.
    const tied = candidates.filter(
      (candidate) =>
        candidate.missing.size === best.missing.size &&
        candidate.shortfall === best.shortfall &&
        candidate.progress === best.progress,
    );

    return `Not enough ingredients. Still need: ${describeChoices(tied)}. Carrying: ${this.inventory.summarize()}`;
  }

  /* ─────────────────────────────── smelting ───────────────────────────── */

  public async smelt(
    rawItemName: string,
    count: number,
    options: { searchRadius: number; timeoutMs: number; fuelName?: string; signal?: AbortSignal },
  ): Promise<ToolResult<SmeltOutcome>> {
    const startedAt = Date.now();

    const input = this.registry.resolveItem(rawItemName);
    if (!input) {
      const suggestions = this.registry.suggestItemNames(rawItemName);
      return fail(
        'UNKNOWN_ITEM',
        `"${rawItemName}" is not a known item.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
      );
    }

    const have = this.inventory.countItem(input.name);
    if (have === 0) {
      return fail(
        'ITEM_NOT_FOUND',
        `No ${input.name} to smelt. Carrying: ${this.inventory.summarize()}`,
      );
    }
    const toSmelt = Math.min(count, have);

    const fuel = this.chooseFuel(toSmelt, options.fuelName);
    if ('error' in fuel) return fuel.error;

    const furnaceBlock = this.findNearestBlock(FURNACE_BLOCKS, options.searchRadius);
    if (!furnaceBlock) {
      return fail(
        'FURNACE_REQUIRED',
        `No furnace within ${options.searchRadius} blocks. ` +
          (this.inventory.findItem('furnace')
            ? 'You are carrying one — place it first with place_block.'
            : 'Craft one from 8 cobblestone first.'),
      );
    }

    const approach = await this.approachBlock(furnaceBlock, options.timeoutMs, options.signal);
    if (approach) return approach;

    const expectedOutput = SMELTING_RECIPES[input.name] ?? null;
    let furnace: Furnace | null = null;

    try {
      furnace = await this.bot.openFurnace(furnaceBlock);

      // Clear any leftover output so the count we observe is ours.
      if (furnace.outputItem()) {
        await furnace.takeOutput().catch(() => undefined);
      }

      await furnace.putFuel(fuel.item.id, null, fuel.count);
      await furnace.putInput(input.id, null, toSmelt);

      const deadline = startedAt + options.timeoutMs;
      const produced = await this.awaitSmeltOutput(furnace, toSmelt, deadline, options.signal);

      if (produced === 0) {
        await this.closeFurnace(furnace);
        if (expectedOutput === null) {
          return fail(
            'NO_RECIPE',
            `${input.name} does not appear to be smeltable — nothing came out of the ${furnaceBlock.name}.`,
            Date.now() - startedAt,
          );
        }
        return fail(
          'TIMEOUT',
          `Smelting ${input.name} produced nothing within ${options.timeoutMs}ms. ` +
            'Smelting takes ~10s per item in a furnace; try a smaller count or a longer timeout.',
          Date.now() - startedAt,
        );
      }

      const outputItem = furnace.outputItem();
      const outputName = outputItem?.name ?? expectedOutput ?? 'unknown';
      if (outputItem) {
        await furnace.takeOutput().catch(() => undefined);
      }
      await this.closeFurnace(furnace);

      return ok(
        {
          input: input.name,
          output: outputName,
          count: produced,
          fuel: fuel.item.name,
          furnace: furnaceBlock.name,
          furnacePosition: toPoint(furnaceBlock.position),
        },
        Date.now() - startedAt,
      );
    } catch (err) {
      if (furnace) await this.closeFurnace(furnace);
      return fail(
        'MINEFLAYER_ERROR',
        `Smelting failed: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - startedAt,
      );
    }
  }

  /** Polls the output slot until `wanted` items appear or the deadline passes. */
  private async awaitSmeltOutput(
    furnace: Furnace,
    wanted: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<number> {
    let produced = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) break;

      const output = furnace.outputItem();
      produced = output?.count ?? 0;
      if (produced >= wanted) return produced;

      // 'update' fires on every furnace progress packet; fall back to a poll so
      // a silent server cannot hang the loop.
      await Promise.race([
        new Promise<void>((resolve) => furnace.once('update', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }

    return furnace.outputItem()?.count ?? produced;
  }

  private async closeFurnace(furnace: Furnace): Promise<void> {
    try {
      await furnace.close();
    } catch (err) {
      this.log.debug({ err }, 'closing furnace failed (ignored)');
    }
  }

  /** Picks a fuel that covers `itemCount` smelts, honouring an explicit request. */
  private chooseFuel(
    itemCount: number,
    requested?: string,
  ): { item: { id: number; name: string }; count: number } | { error: ToolResult<never> } {
    const candidates: Array<{ id: number; name: string; have: number; itemsPerUnit: number }> = [];

    for (const item of this.bot.inventory.items()) {
      const entry = FUEL_VALUES.find((fuel) => fuel.match(item.name));
      if (!entry) continue;
      const existing = candidates.find((candidate) => candidate.name === item.name);
      if (existing) existing.have += item.count;
      else {
        candidates.push({
          id: item.type,
          name: item.name,
          have: item.count,
          itemsPerUnit: entry.itemsPerUnit,
        });
      }
    }

    if (requested) {
      const resolved = this.registry.resolveItem(requested);
      if (!resolved) {
        return { error: fail('UNKNOWN_ITEM', `"${requested}" is not a known item.`) };
      }
      const match = candidates.find((candidate) => candidate.name === resolved.name);
      if (!match) {
        return {
          error: fail(
            'NO_FUEL',
            `${resolved.name} is not a usable furnace fuel, or you have none. ` +
              `Usable fuels you carry: ${candidates.map((c) => c.name).join(', ') || 'none'}`,
          ),
        };
      }
      const needed = Math.min(match.have, Math.max(1, Math.ceil(itemCount / match.itemsPerUnit)));
      return { item: { id: match.id, name: match.name }, count: needed };
    }

    if (candidates.length === 0) {
      return {
        error: fail(
          'NO_FUEL',
          'No furnace fuel in inventory. Coal, charcoal, or any wooden item works. ' +
            `Carrying: ${this.inventory.summarize()}`,
        ),
      };
    }

    // Burn the cheapest fuel that still covers the job, keeping coal for later
    // when planks would do.
    candidates.sort((a, b) => {
      const aCovers = a.have * a.itemsPerUnit >= itemCount;
      const bCovers = b.have * b.itemsPerUnit >= itemCount;
      if (aCovers !== bCovers) return aCovers ? -1 : 1;
      return a.itemsPerUnit - b.itemsPerUnit;
    });

    const chosen = candidates[0]!;
    const needed = Math.min(chosen.have, Math.max(1, Math.ceil(itemCount / chosen.itemsPerUnit)));
    return { item: { id: chosen.id, name: chosen.name }, count: needed };
  }

  /* ─────────────────────────────── helpers ────────────────────────────── */

  public findNearestBlock(names: readonly string[], radius: number): Block | null {
    const ids: number[] = [];
    for (const name of names) {
      const resolved = this.registry.resolveBlock(name);
      if (resolved) ids.push(resolved.id);
    }
    if (ids.length === 0) return null;
    try {
      return this.bot.findBlock({ matching: ids, maxDistance: radius });
    } catch {
      return null;
    }
  }

  /** Walks into reach of `block`; returns a failure result when it cannot. */
  private async approachBlock(
    block: Block,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ToolResult<never> | null> {
    const centre = { x: block.position.x + 0.5, y: block.position.y + 0.5, z: block.position.z + 0.5 };
    if (dist(toPoint(this.bot.entity.position), centre) <= INTERACT_REACH) return null;

    const move = await this.movement.moveToBlock(toPoint(block.position), {
      reach: 2.5,
      timeoutMs: Math.max(3_000, Math.floor(timeoutMs * 0.5)),
      ...(signal ? { signal } : {}),
    });
    if (move.success) return null;

    return fail(move.error, `Could not reach the ${block.name}: ${move.details}`);
  }

  /**
   * Counts what the player is actually carrying.
   *
   * Deliberately skips the window's result slot and crafting grid: Mineflayer
   * writes the not-yet-confirmed output there locally, so counting those slots
   * reports a craft that the server never delivered — and the agent's next
   * move spends a second set of ingredients on it.
   */
  private snapshot(): Map<string, number> {
    const counts = new Map<string, number>();
    const window = this.bot.inventory as unknown as {
      slots: Array<{ name: string; count: number } | null>;
      inventoryStart?: number;
      inventoryEnd?: number;
    };
    const start = window.inventoryStart ?? 0;
    const end = window.inventoryEnd ?? window.slots.length;
    for (let slot = start; slot < end; slot += 1) {
      const item = window.slots[slot];
      if (!item) continue;
      counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    }
    return counts;
  }
}

/**
 * Renders a set of equally-close recipes as one requirement list.
 *
 * Ingredients every candidate needs identically are stated plainly; ingredients
 * that differ between candidates become an explicit choice, so the agent can go
 * after whichever material it can actually reach.
 */
function describeChoices(candidates: Array<{ missing: Map<string, number> }>): string {
  const first = candidates[0]!;

  // An ingredient is "fixed" when every candidate needs it in the same amount.
  const fixed: Array<{ item: string; need: number }> = [];
  for (const [item, need] of first.missing) {
    if (candidates.every((candidate) => candidate.missing.get(item) === need)) {
      fixed.push({ item, need });
    }
  }
  const fixedNames = new Set(fixed.map((entry) => entry.item));

  // Whatever is left varies; group the options by the quantity required.
  const byQuantity = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    for (const [item, need] of candidate.missing) {
      if (fixedNames.has(item)) continue;
      const bucket = byQuantity.get(need) ?? new Set<string>();
      bucket.add(item);
      byQuantity.set(need, bucket);
    }
  }

  const parts = fixed.map((entry) => `${entry.need}x ${entry.item}`);
  for (const [need, options] of [...byQuantity.entries()].sort((a, b) => b[0] - a[0])) {
    const names = [...options].sort();
    parts.push(
      names.length === 1
        ? `${need}x ${names[0]}`
        : `${need}x any of: ${names.slice(0, 6).join(', ')}${names.length > 6 ? `, +${names.length - 6} more` : ''}`,
    );
  }

  return parts.join(', ');
}
