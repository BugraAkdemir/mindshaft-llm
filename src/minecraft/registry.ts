import minecraftData, { type IndexedData } from 'minecraft-data';

export type BlockPriority = 'critical' | 'resource' | 'utility' | 'bulk';

/** Blocks that change what the agent may safely do; always reported. */
const CRITICAL_BLOCKS = new Set([
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'magma_block',
  'campfire',
  'soul_campfire',
  'water',
  'flowing_water',
  'powder_snow',
  'sweet_berry_bush',
  'cactus',
  'wither_rose',
  'end_portal',
  'nether_portal',
  'tnt',
]);

/** Interactable / structural blocks that unlock progression steps. */
const UTILITY_BLOCKS = new Set([
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'shulker_box',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
  'brewing_stand',
  'enchanting_table',
  'smithing_table',
  'cartography_table',
  'fletching_table',
  'grindstone',
  'stonecutter',
  'loom',
  'composter',
  'lectern',
  'bell',
  'beacon',
  'cauldron',
  'water_cauldron',
  'lava_cauldron',
  'respawn_anchor',
  'end_portal_frame',
  'bookshelf',
  'jukebox',
  'note_block',
  'hopper',
  'dispenser',
  'dropper',
  'observer',
  'lodestone',
  'spawner',
  'beehive',
  'bee_nest',
  'ladder',
  'scaffolding',
  'torch',
  'soul_torch',
  'lantern',
  'glowstone',
  'sea_lantern',
  'shroomlight',
]);

/** Suffix/keyword tests for whole families of blocks. */
const UTILITY_PATTERNS = [/_bed$/, /_door$/, /_trapdoor$/, /_fence_gate$/, /_sign$/, /_button$/, /_shulker_box$/];

const RESOURCE_BLOCKS = new Set([
  'obsidian',
  'crying_obsidian',
  'clay',
  'snow_block',
  'ice',
  'packed_ice',
  'blue_ice',
  'coal_block',
  'iron_block',
  'gold_block',
  'diamond_block',
  'emerald_block',
  'copper_block',
  'redstone_block',
  'lapis_block',
  'netherite_block',
  'amethyst_block',
  'budding_amethyst',
  'honey_block',
  'slime_block',
  'pumpkin',
  'melon',
  'hay_block',
  'bamboo',
  'sugar_cane',
  'wheat',
  'carrots',
  'potatoes',
  'beetroots',
  'farmland',
  'cocoa',
  'nether_wart',
  'brown_mushroom',
  'red_mushroom',
  'kelp',
  'seagrass',
  'cobweb',
  'dripstone_block',
  'pointed_dripstone',
  'moss_block',
  'mud',
  'soul_sand',
  'soul_soil',
  'glow_lichen',
  'spore_blossom',
]);

const RESOURCE_PATTERNS = [
  /_ore$/,
  /^ancient_debris$/,
  /_log$/,
  /_wood$/,
  /_stem$/,
  /_hyphae$/,
  /^raw_.*_block$/,
  /_sapling$/,
];

/**
 * Terrain that exists in enormous quantities. Reported with a tiny sample so
 * the model knows "there is stone here" without 400 identical entries.
 */
const BULK_BLOCKS = new Set([
  'stone',
  'cobblestone',
  'deepslate',
  'cobbled_deepslate',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'calcite',
  'smooth_basalt',
  'basalt',
  'blackstone',
  'netherrack',
  'end_stone',
  'dirt',
  'coarse_dirt',
  'rooted_dirt',
  'grass_block',
  'podzol',
  'mycelium',
  'sand',
  'red_sand',
  'sandstone',
  'gravel',
  'terracotta',
]);

export interface ResolvedItem {
  id: number;
  name: string;
  displayName: string;
  stackSize: number;
}

export interface ResolvedBlock {
  id: number;
  name: string;
  displayName: string;
  diggable: boolean;
  hardness: number | null;
}

export type EntityCategory = 'hostile' | 'passive' | 'player' | 'villager' | 'item' | 'other';

/**
 * Version-pinned wrapper over minecraft-data.
 *
 * Every name the LLM supplies is resolved through here before it reaches
 * Mineflayer, which is what keeps `"diamond_sword_of_doom"` from turning into a
 * crash instead of a structured `UNKNOWN_ITEM` failure.
 */
export class GameRegistry {
  public readonly data: IndexedData;
  public readonly version: string;

  private readonly blockPriorityCache = new Map<string, BlockPriority | null>();
  private observableIdsCache: { rare: number[]; bulk: number[] } | null = null;

  public constructor(version: string) {
    const data = minecraftData(version);
    if (!data) {
      throw new Error(`minecraft-data has no definitions for Minecraft version "${version}".`);
    }
    this.data = data;
    this.version = version;
  }

  public static fromBotVersion(version: string): GameRegistry {
    return new GameRegistry(version);
  }

  /* ───────────────────────────── name lookups ─────────────────────────── */

  /** Accepts `stone`, `minecraft:stone` and `Stone`. */
  public normalizeName(raw: string): string {
    return raw.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  }

  public resolveItem(raw: string): ResolvedItem | null {
    const name = this.normalizeName(raw);
    const item = this.data.itemsByName[name];
    if (!item) return null;
    return {
      id: item.id,
      name: item.name,
      displayName: item.displayName,
      stackSize: item.stackSize,
    };
  }

  public resolveBlock(raw: string): ResolvedBlock | null {
    const name = this.normalizeName(raw);
    const block = this.data.blocksByName[name];
    if (!block) return null;
    return {
      id: block.id,
      name: block.name,
      displayName: block.displayName,
      diggable: block.diggable !== false,
      hardness: block.hardness ?? null,
    };
  }

  /** Suggests close matches so a bad name becomes actionable feedback. */
  public suggestItemNames(raw: string, limit = 5): string[] {
    return suggest(this.normalizeName(raw), Object.keys(this.data.itemsByName), limit);
  }

  public suggestBlockNames(raw: string, limit = 5): string[] {
    return suggest(this.normalizeName(raw), Object.keys(this.data.blocksByName), limit);
  }

  public isFood(itemName: string): boolean {
    return this.data.foodsByName[this.normalizeName(itemName)] !== undefined;
  }

  public foodPoints(itemName: string): number {
    return this.data.foodsByName[this.normalizeName(itemName)]?.foodPoints ?? 0;
  }

  /* ──────────────────────────── classification ────────────────────────── */

  public classifyEntity(entityName: string | undefined, entityType: string | undefined): EntityCategory {
    if (entityType === 'player') return 'player';
    const name = entityName ? this.normalizeName(entityName) : '';
    if (name === 'item') return 'item';
    if (name === 'villager' || name === 'wandering_trader') return 'villager';

    const def = this.data.entitiesByName[name];
    const category = def?.category;
    const type = def?.type ?? entityType;

    if (category === 'Hostile mobs' || type === 'hostile') return 'hostile';
    if (category === 'Passive mobs' || type === 'animal' || type === 'passive' || type === 'ambient') {
      return 'passive';
    }
    return 'other';
  }

  public blockPriority(blockName: string): BlockPriority | null {
    const name = this.normalizeName(blockName);
    const cached = this.blockPriorityCache.get(name);
    if (cached !== undefined) return cached;

    let priority: BlockPriority | null = null;
    if (CRITICAL_BLOCKS.has(name)) priority = 'critical';
    else if (RESOURCE_BLOCKS.has(name) || RESOURCE_PATTERNS.some((re) => re.test(name))) {
      priority = 'resource';
    } else if (UTILITY_BLOCKS.has(name) || UTILITY_PATTERNS.some((re) => re.test(name))) {
      priority = 'utility';
    } else if (BULK_BLOCKS.has(name)) priority = 'bulk';

    this.blockPriorityCache.set(name, priority);
    return priority;
  }

  /**
   * Block ids the observer scans for, split so bulk terrain can be queried
   * with a much smaller result cap than rare blocks.
   */
  public observableBlockIds(): { rare: number[]; bulk: number[] } {
    if (this.observableIdsCache) return this.observableIdsCache;

    const rare: number[] = [];
    const bulk: number[] = [];
    for (const block of this.data.blocksArray) {
      const priority = this.blockPriority(block.name);
      if (priority === null) continue;
      if (priority === 'bulk') bulk.push(block.id);
      else rare.push(block.id);
    }
    this.observableIdsCache = { rare, bulk };
    return this.observableIdsCache;
  }

  /** Block ids whose names contain any of `keywords` — used for goal relevance. */
  public blockIdsMatching(keywords: string[]): number[] {
    if (keywords.length === 0) return [];
    const ids: number[] = [];
    for (const block of this.data.blocksArray) {
      if (keywords.some((keyword) => block.name.includes(keyword))) ids.push(block.id);
    }
    return ids;
  }
}

/* ───────────────────────── fuzzy name suggestions ─────────────────────── */

function suggest(needle: string, haystack: string[], limit: number): string[] {
  if (needle === '') return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of haystack) {
    let score = 0;
    if (name === needle) score = 1000;
    else if (name.includes(needle)) score = 500 - Math.abs(name.length - needle.length);
    else if (needle.includes(name)) score = 400 - Math.abs(name.length - needle.length);
    else {
      const distance = levenshtein(needle, name, 4);
      if (distance <= 3) score = 100 - distance * 10;
    }
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((entry) => entry.name);
}

/** Levenshtein distance with early exit once `max` is exceeded. */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? max + 1;
}
