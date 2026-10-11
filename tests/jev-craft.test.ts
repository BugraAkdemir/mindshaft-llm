import { describe, expect, it } from 'vitest';
import { nextCraftable, plankCount } from '../src/llm/jev-craft.js';

describe('plankCount', () => {
  it('counts four planks per log', () => {
    expect(plankCount({ oak_log: 3 })).toBe(12);
  });

  it('pools every log species', () => {
    expect(plankCount({ oak_log: 1, birch_log: 1 })).toBe(8);
  });

  it('adds planks already in the inventory', () => {
    expect(plankCount({ oak_log: 1, oak_planks: 3 })).toBe(7);
  });
});

describe('nextCraftable', () => {
  it('turns logs into planks', () => {
    expect(nextCraftable({ oak_log: 3 })).toBe('oak_planks');
  });

  it('turns planks into a crafting table', () => {
    expect(nextCraftable({ oak_planks: 4 })).toBe('crafting_table');
  });

  it('escalates to a wooden pickaxe once a table is available', () => {
    expect(nextCraftable({ oak_planks: 8, stick: 4 })).toBe('wooden_pickaxe');
  });

  it('escalates to stone tools from cobblestone', () => {
    expect(nextCraftable({ cobblestone: 8, stick: 4 })).toBe('stone_pickaxe');
  });

  it('does not escalate to stone tools without sticks', () => {
    // 8 cobblestone with no sticks still buys the furnace, but never a pickaxe.
    expect(nextCraftable({ cobblestone: 8 })).toBe('furnace');
  });

  it('returns undefined for an empty inventory', () => {
    expect(nextCraftable({})).toBeUndefined();
  });

  it('ignores items the ladder does not use', () => {
    expect(nextCraftable({ dirt: 40, torch: 12 })).toBeUndefined();
  });
});