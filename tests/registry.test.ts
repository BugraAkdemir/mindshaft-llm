import { describe, expect, it } from 'vitest';
import { GameRegistry, levenshtein } from '../src/minecraft/registry.js';
import { toolKindFor } from '../src/minecraft/inventory.js';
import { isReplaceable } from '../src/minecraft/blocks.js';

const registry = new GameRegistry('1.21.4');

describe('name resolution', () => {
  it('resolves plain, namespaced and mixed-case names', () => {
    expect(registry.resolveItem('iron_ingot')?.name).toBe('iron_ingot');
    expect(registry.resolveItem('minecraft:iron_ingot')?.name).toBe('iron_ingot');
    expect(registry.resolveItem('  IRON_INGOT  ')?.name).toBe('iron_ingot');
    expect(registry.resolveItem('iron ingot')?.name).toBe('iron_ingot');
  });

  it('returns null for invented names', () => {
    expect(registry.resolveItem('diamond_sword_of_doom')).toBeNull();
    expect(registry.resolveBlock('unobtainium_ore')).toBeNull();
  });

  it('resolves blocks with their diggability and hardness', () => {
    const stone = registry.resolveBlock('stone');
    expect(stone?.id).toBeTypeOf('number');
    expect(stone?.diggable).toBe(true);
    expect(stone?.hardness).toBeGreaterThan(0);

    expect(registry.resolveBlock('bedrock')?.diggable).toBe(false);
  });

  it('suggests near-miss names, which is what makes a bad name actionable', () => {
    expect(registry.suggestItemNames('iron_picaxe')).toContain('iron_pickaxe');
    expect(registry.suggestBlockNames('craftingtable').length).toBeGreaterThan(0);
    expect(registry.suggestItemNames('')).toEqual([]);
  });

  it('identifies food and its nutrition', () => {
    expect(registry.isFood('bread')).toBe(true);
    expect(registry.isFood('cooked_beef')).toBe(true);
    expect(registry.isFood('stone')).toBe(false);
    expect(registry.foodPoints('bread')).toBeGreaterThan(0);
    expect(registry.foodPoints('stone')).toBe(0);
  });

  it('rejects a Minecraft version it has no data for', () => {
    expect(() => new GameRegistry('0.0.1-nonexistent')).toThrow(/minecraft-data/);
  });
});

describe('entity classification', () => {
  it('classifies hostiles, passives, players, villagers and drops', () => {
    expect(registry.classifyEntity('zombie', 'hostile')).toBe('hostile');
    expect(registry.classifyEntity('creeper', 'hostile')).toBe('hostile');
    expect(registry.classifyEntity('skeleton', 'mob')).toBe('hostile');
    expect(registry.classifyEntity('cow', 'animal')).toBe('passive');
    expect(registry.classifyEntity('sheep', 'mob')).toBe('passive');
    expect(registry.classifyEntity('player', 'player')).toBe('player');
    expect(registry.classifyEntity('villager', 'mob')).toBe('villager');
    expect(registry.classifyEntity('wandering_trader', 'mob')).toBe('villager');
    expect(registry.classifyEntity('item', 'object')).toBe('item');
  });

  it('falls back to "other" for unknown or irrelevant entities', () => {
    expect(registry.classifyEntity('arrow', 'projectile')).toBe('other');
    expect(registry.classifyEntity(undefined, undefined)).toBe('other');
    expect(registry.classifyEntity('made_up_mob', 'mob')).toBe('other');
  });
});

describe('block prioritisation', () => {
  it('marks hazards critical', () => {
    for (const name of ['lava', 'fire', 'water', 'cactus', 'tnt']) {
      expect(registry.blockPriority(name)).toBe('critical');
    }
  });

  it('marks ores, logs and harvestables as resources', () => {
    for (const name of ['iron_ore', 'deepslate_diamond_ore', 'ancient_debris', 'oak_log', 'warped_stem', 'wheat']) {
      expect(registry.blockPriority(name)).toBe('resource');
    }
  });

  it('marks workstations and openables as utility', () => {
    for (const name of ['crafting_table', 'furnace', 'chest', 'oak_door', 'red_bed', 'enchanting_table']) {
      expect(registry.blockPriority(name)).toBe('utility');
    }
  });

  it('marks common terrain as bulk', () => {
    for (const name of ['stone', 'dirt', 'grass_block', 'sand', 'gravel', 'netherrack']) {
      expect(registry.blockPriority(name)).toBe('bulk');
    }
  });

  it('returns null for blocks not worth reporting', () => {
    expect(registry.blockPriority('air')).toBeNull();
    expect(registry.blockPriority('white_wool')).toBeNull();
  });

  it('splits observable ids into rare and bulk sets, with no overlap', () => {
    const { rare, bulk } = registry.observableBlockIds();
    expect(rare.length).toBeGreaterThan(50);
    expect(bulk.length).toBeGreaterThan(5);
    expect(rare.some((id) => bulk.includes(id))).toBe(false);
  });

  it('caches the observable id sets', () => {
    expect(registry.observableBlockIds()).toBe(registry.observableBlockIds());
  });

  it('finds goal-relevant block ids by keyword', () => {
    const ids = registry.blockIdsMatching(['diamond']);
    expect(ids.length).toBeGreaterThan(0);
    expect(registry.blockIdsMatching([])).toEqual([]);
  });
});

describe('tool selection heuristics', () => {
  it('maps blocks to the right tool family', () => {
    expect(toolKindFor('iron_ore')).toBe('pickaxe');
    expect(toolKindFor('deepslate')).toBe('pickaxe');
    expect(toolKindFor('oak_log')).toBe('axe');
    expect(toolKindFor('crafting_table')).toBe('axe');
    expect(toolKindFor('dirt')).toBe('shovel');
    expect(toolKindFor('gravel')).toBe('shovel');
    expect(toolKindFor('hay_block')).toBe('hoe');
    expect(toolKindFor('cobweb')).toBe('shears');
  });

  it('returns null for blocks with no preferred tool', () => {
    expect(toolKindFor('glass')).toBeNull();
  });

  it('ignores a namespace prefix', () => {
    expect(toolKindFor('minecraft:iron_ore')).toBe('pickaxe');
  });
});

describe('placement replaceability', () => {
  it('treats air, liquids and plants as replaceable', () => {
    for (const name of ['air', 'cave_air', 'water', 'lava', 'short_grass', 'snow']) {
      expect(isReplaceable(name)).toBe(true);
    }
  });

  it('treats solid blocks as not replaceable', () => {
    for (const name of ['stone', 'oak_log', 'crafting_table']) {
      expect(isReplaceable(name)).toBe(false);
    }
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('exits early past the cap rather than doing the full matrix', () => {
    expect(levenshtein('a', 'abcdefghij', 3)).toBe(4);
    expect(levenshtein('abcdefgh', 'zzzzzzzz', 2)).toBe(3);
  });
});
