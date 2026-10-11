/**
 * The craft ladder.
 *
 * A decision model answers *whether* to craft; it cannot say *what*. This
 * decides what, from the raw inventory counts. Deliberately short and greedy:
 * a wrong item wastes a turn, a missing item is recoverable, so the ladder
 * stops at the first thing it can build rather than optimising a recipe tree.
 */

/** Every log species the game turns into 4 planks. */
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];

/** Planks are pooled under a single key so any species feeds any recipe. */
const PLANKS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'];

interface Rule {
  item: string;
  /** Ingredients, keyed by the pooled names above where applicable. */
  from: Record<string, number>;
}

/**
 * Priority order. Anything craftable in a 2×2 inventory grid comes before the
 * crafting table, because holding the table but no pickaxe gets you nothing.
 */
const RULES: Rule[] = [
  { item: 'oak_planks', from: { logs: 1 } },
  { item: 'torch', from: { stick: 1, coal: 1 } },
  { item: 'wooden_pickaxe', from: { planks: 3, stick: 2 } },
  { item: 'wooden_axe', from: { planks: 3, stick: 2 } },
  { item: 'wooden_sword', from: { planks: 2, stick: 1 } },
  { item: 'crafting_table', from: { planks: 4 } },
  { item: 'stone_pickaxe', from: { cobblestone: 3, stick: 2 } },
  { item: 'stone_axe', from: { cobblestone: 3, stick: 2 } },
  { item: 'stone_sword', from: { cobblestone: 2, stick: 1 } },
  { item: 'furnace', from: { cobblestone: 8 } },
];

function has(counts: Record<string, number>, need: Record<string, number>): boolean {
  return Object.entries(need).every(([item, amount]) => (counts[item] ?? 0) >= amount);
}

/**
 * Total planks available, counting logs at the game's 1 log → 4 planks rate.
 * Exported because the crafting tool needs the same arithmetic.
 */
export function plankCount(counts: Record<string, number>): number {
  const fromLogs = LOGS.reduce((total, id) => total + (counts[id] ?? 0), 0) * 4;
  const fromPlanks = PLANKS.reduce((total, id) => total + (counts[id] ?? 0), 0);
  return fromLogs + fromPlanks;
}

/** The next item worth crafting, or undefined when nothing is buildable. */
export function nextCraftable(counts: Record<string, number>): string | undefined {
  const expanded: Record<string, number> = {
    ...counts,
    planks: plankCount(counts),
    logs: LOGS.reduce((total, id) => total + (counts[id] ?? 0), 0),
  };
  return RULES.find((rule) => has(expanded, rule.from))?.item;
}