import { nextCraftable } from './jev-craft.js';
import { nearestGroup, nearestOf, type JevAnswers } from './jev-format.js';
import type { WorldState } from '../types.js';

type Args = Record<string, unknown>;

/** How many blocks to take in one go. */
const MINE_COUNT: Record<JevAnswers['urgency'], number> = { calm: 3, tense: 4, critical: 6 };

/** How long to sit still while things sort themselves out. */
const WAIT_SECONDS: Record<JevAnswers['urgency'], number> = { calm: 8, tense: 3, critical: 1 };

type Builder = (answers: JevAnswers, observation: WorldState | undefined) => Args;

/** Absolute position of the chosen target, from its nearest observed instance. */
function targetPoint(answers: JevAnswers, observation: WorldState | undefined) {
  if (!answers.target || !observation) return undefined;
  return nearestGroup(observation.nearbyBlocks, answers.target)?.nearest;
}

function firstOwned(counts: Record<string, number>, items: readonly string[]): string | undefined {
  return items.find((item) => (counts[item] ?? 0) > 0);
}

const FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'bread', 'apple'] as const;
const TOOLS = ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'] as const;

/**
 * One builder per registered tool. Every builder is pure, and every one returns
 * `{}` rather than guessing when it lacks the information — the registry's Zod
 * schema then reports the omission through the normal correction path, which is
 * far better than acting on an invented block name.
 */
const BUILDERS: Record<string, Builder> = {
  observe: (a) => (a.target ? { focus: a.target } : {}),

  mine: (a) => (a.target ? { block: a.target, count: MINE_COUNT[a.urgency], collect: true } : {}),

  move_to: (a, o) => {
    const point = targetPoint(a, o);
    return point ? { x: point.x, y: point.y, z: point.z } : {};
  },

  look_at: (a, o) => {
    const point =
      targetPoint(a, o) ?? nearestOf(o?.entities ?? [], 'hostile')?.position ?? undefined;
    return point ? { x: point.x, y: point.y, z: point.z } : {};
  },

  interact: (a, o) => {
    const point = targetPoint(a, o);
    return point || a.target ? { block: a.target } : {};
  },

  attack: (a, o) => {
    const target = nearestOf(o?.threats ?? [], 'hostile') ?? nearestOf(o?.entities ?? [], 'hostile');
    if (!target) return {};
    return { entity_id: target.id, max_swings: a.urgency === 'critical' ? 24 : 12 };
  },

  eat: (a, o) => {
    const item = firstOwned(o?.inventoryCounts ?? {}, FOOD);
    return item ? { item } : {};
  },

  equip: (a, o) => {
    const item = firstOwned(o?.inventoryCounts ?? {}, TOOLS);
    return item ? { item } : {};
  },

  collect: () => ({ radius: 12, max_items: 5 }),

  craft: (a, o) => {
    const item = nextCraftable(o?.inventoryCounts ?? {});
    return item ? { item, count: 1 } : {};
  },

  smelt: (a, o) => {
    const counts = o?.inventoryCounts ?? {};
    const ore = firstOwned(counts, ['raw_iron', 'iron_ore', 'raw_gold', 'gold_ore']);
    // A furnace must be placed nearby before anything can be smelted.
    const placed = (o?.nearbyBlocks ?? []).some((g) => g.type === 'furnace');
    if (!ore || !placed) return {};
    return { item: ore.startsWith('raw_') ? ore : ore.replace('_ore', '') };
  },

  // A decision model cannot author prose, so the line is fixed.
  say: (a) => ({ message: a.target ? `Working on ${a.target}.` : 'Working on it.' }),

  jump: () => ({ count: 1 }),
  pillar_up: (a) => ({ height: a.urgency === 'critical' ? 4 : 2 }),
  sneak: () => ({ enabled: true }),
  sprint: () => ({ enabled: true }),
  wait: (a) => ({ seconds: WAIT_SECONDS[a.urgency], reason: 'waiting for the situation to change' }),
};

/** Arguments for the chosen tool, or `{}` when it has no builder. */
export function buildArguments(
  answers: JevAnswers,
  observation: WorldState | undefined,
): Args {
  const builder = BUILDERS[answers.tool];
  return builder ? builder(answers, observation) : {};
}

/** Whether this provider can fill arguments for `tool` at all. */
export function supportsArgs(tool: string): boolean {
  return tool in BUILDERS;
}