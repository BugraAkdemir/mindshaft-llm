import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { describeTimeOfDay, WorldObserver } from '../src/minecraft/observer.js';
import { GameRegistry } from '../src/minecraft/registry.js';
import { compressState } from '../src/agent/prompts.js';
import { asBot, createMockBot, key, type MockBotOptions } from './helpers/mock-bot.js';
import { testConfig } from './helpers/fixtures.js';

const VERSION = '1.21.4';

function buildObserver(options: MockBotOptions = {}, envOverrides: Record<string, string> = {}) {
  const bot = createMockBot({ version: VERSION, ...options });
  const registry = new GameRegistry(VERSION);
  const cfg = testConfig(envOverrides).agent;
  return { bot, observer: new WorldObserver(asBot(bot), registry, cfg), registry, cfg };
}

/** Fills a cube of identical blocks, as a real forest or stone field would. */
function fillBlocks(name: string, from: [number, number, number], to: [number, number, number]): Map<string, string> {
  const blocks = new Map<string, string>();
  for (let x = from[0]; x <= to[0]; x += 1) {
    for (let y = from[1]; y <= to[1]; y += 1) {
      for (let z = from[2]; z <= to[2]; z += 1) {
        blocks.set(key(x, y, z), name);
      }
    }
  }
  return blocks;
}

describe('world-state compression — blocks', () => {
  it('collapses many identical blocks into one group with a count and nearest', () => {
    // 27 oak logs: a text model must not receive 27 entries.
    const blocks = fillBlocks('oak_log', [3, 64, 3], [5, 66, 5]);
    const { observer } = buildObserver({ blocks, position: new Vec3(0.5, 64, 0.5) });

    const state = observer.observe();
    const logs = state.nearbyBlocks.filter((group) => group.type === 'oak_log');

    expect(logs).toHaveLength(1);
    expect(logs[0]!.count).toBe(27);
    // The nearest corner of the cube is (3,64,3).
    expect(logs[0]!.nearest).toEqual({ x: 3, y: 64, z: 3 });
    expect(logs[0]!.distance).toBeGreaterThan(0);
  });

  it('carries relative direction and delta for the nearest instance', () => {
    const blocks = new Map([[key(5, 64, -5), 'diamond_ore']]);
    const { observer } = buildObserver({ blocks, position: new Vec3(0.5, 64, 0.5) });

    const group = observer.observe().nearbyBlocks.find((entry) => entry.type === 'diamond_ore');
    expect(group).toBeDefined();
    expect(group!.direction).toBe('north-east');
    expect(group!.relative.x).toBeGreaterThan(0);
    expect(group!.relative.z).toBeLessThan(0);
  });

  it('ranks hazards above workstations, workstations above resources, and bulk last', () => {
    const blocks = new Map([
      [key(8, 64, 0), 'stone'],
      [key(7, 64, 0), 'oak_log'],
      [key(6, 64, 0), 'crafting_table'],
      [key(5, 64, 0), 'lava'],
    ]);
    const { observer } = buildObserver({ blocks, position: new Vec3(0.5, 64, 0.5) });

    const order = observer.observe().nearbyBlocks.map((group) => group.type);
    expect(order.indexOf('lava')).toBeLessThan(order.indexOf('crafting_table'));
    expect(order.indexOf('crafting_table')).toBeLessThan(order.indexOf('oak_log'));
    expect(order.indexOf('oak_log')).toBeLessThan(order.indexOf('stone'));
  });

  it('caps the number of block groups', () => {
    const blocks = new Map<string, string>();
    const names = [
      'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
      'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore',
      'copper_ore', 'emerald_ore', 'crafting_table', 'furnace', 'chest', 'barrel',
      'stone', 'dirt', 'sand', 'gravel', 'obsidian', 'clay',
    ];
    names.forEach((name, index) => blocks.set(key(index % 10, 64 + Math.floor(index / 10), 2), name));

    const { observer } = buildObserver({ blocks, position: new Vec3(0.5, 64, 0.5) });
    expect(observer.observe().nearbyBlocks.length).toBeLessThanOrEqual(18);
  });

  it('never reports air', () => {
    const { observer } = buildObserver({ position: new Vec3(0.5, 64, 0.5) });
    const types = observer.observe().nearbyBlocks.map((group) => group.type);
    expect(types).not.toContain('air');
  });
});

describe('world-state compression — inventory', () => {
  it('aggregates duplicate stacks and lists their slots', () => {
    const { observer } = buildObserver({
      inventory: [
        { name: 'oak_log', type: 1, count: 64, slot: 9 },
        { name: 'oak_log', type: 1, count: 12, slot: 10 },
        { name: 'stone', type: 2, count: 30, slot: 11 },
      ],
    });

    const inventory = observer.observe().inventory;
    const logs = inventory.find((entry) => entry.item === 'oak_log');
    expect(logs).toMatchObject({ count: 76 });
    expect(logs!.slots).toEqual([9, 10]);
    expect(inventory).toHaveLength(2);
  });

  it('reports the lowest durability among identical tools', () => {
    const { observer } = buildObserver({
      inventory: [
        { name: 'iron_pickaxe', type: 5, count: 1, slot: 9, maxDurability: 250, durabilityUsed: 25 },
        { name: 'iron_pickaxe', type: 5, count: 1, slot: 10, maxDurability: 250, durabilityUsed: 200 },
      ],
    });

    const pickaxe = observer.observe().inventory.find((entry) => entry.item === 'iron_pickaxe');
    expect(pickaxe!.count).toBe(2);
    expect(pickaxe!.durability).toBe(20);
  });

  it('omits durability for items that have none', () => {
    const { observer } = buildObserver({ inventory: [{ name: 'cobblestone', type: 3, count: 12, slot: 9 }] });
    expect(observer.observe().inventory[0]!.durability).toBeUndefined();
  });

  it('builds a counts map for quick lookups', () => {
    const { observer } = buildObserver({
      inventory: [{ name: 'iron_ingot', type: 7, count: 3, slot: 9 }],
    });
    expect(observer.observe().inventoryCounts['iron_ingot']).toBe(3);
  });
});

describe('world-state compression — entities', () => {
  it('classifies, sorts and describes nearby entities', () => {
    const { observer } = buildObserver({
      position: new Vec3(0.5, 64, 0.5),
      entities: [
        { id: 10, name: 'cow', type: 'animal', position: new Vec3(3, 64, 0), height: 1.4, width: 0.9, health: 10 },
        { id: 11, name: 'zombie', type: 'hostile', position: new Vec3(0, 64, -9), height: 1.95, width: 0.6, health: 20 },
        { id: 12, name: 'player', username: 'Steve', type: 'player', position: new Vec3(6, 64, 0), height: 1.8, width: 0.6 },
      ],
    });

    const state = observer.observe();
    // Hostiles first, then players, then passive mobs.
    expect(state.entities.map((entity) => entity.category)).toEqual(['hostile', 'player', 'passive']);

    const zombie = state.entities[0]!;
    expect(zombie.direction).toBe('north');
    expect(zombie.distance).toBeCloseTo(9.5, 0);
    expect(zombie.health).toBe(20);

    expect(state.threats).toHaveLength(1);
    expect(state.nearbyPlayers[0]).toContain('Steve');
  });

  it('describes dropped item stacks', () => {
    const { observer } = buildObserver({
      entities: [
        {
          id: 20,
          name: 'item',
          type: 'object',
          position: new Vec3(2, 64, 0),
          height: 0.25,
          width: 0.25,
          droppedItem: { name: 'oak_log', count: 4 },
        },
      ],
    });

    const drop = observer.observe().entities.find((entity) => entity.category === 'item');
    expect(drop).toBeDefined();
    expect(drop!.itemName).toBe('oak_log');
    expect(drop!.itemCount).toBe(4);
  });

  it('excludes entities beyond the configured radius and filters out noise', () => {
    const { observer } = buildObserver(
      {
        entities: [
          { id: 30, name: 'zombie', type: 'hostile', position: new Vec3(100, 64, 0), height: 1.95, width: 0.6 },
          { id: 31, name: 'experience_orb', type: 'other', position: new Vec3(2, 64, 0), height: 0.5, width: 0.5 },
          { id: 32, name: 'arrow', type: 'projectile', position: new Vec3(2, 64, 1), height: 0.5, width: 0.5 },
        ],
      },
      { ENTITY_RADIUS: '24' },
    );

    expect(observer.observe().entities).toHaveLength(0);
  });

  it('never includes the bot itself', () => {
    const { observer, bot } = buildObserver();
    expect(observer.observe().entities.some((entity) => entity.id === bot.entity.id)).toBe(false);
  });
});

describe('world-state compression — player and environment', () => {
  it('reports player vitals, facing and equipment', () => {
    const bot = createMockBot({ version: VERSION, health: 13, food: 7, oxygenLevel: 12 });
    bot.inventory.slots[5] = { name: 'iron_helmet', type: 40, count: 1, slot: 5 };
    bot.heldItem = { name: 'stone_pickaxe', type: 41, count: 1, slot: 36 };

    const observer = new WorldObserver(asBot(bot), new GameRegistry(VERSION), testConfig().agent);
    const player = observer.observe().player;

    expect(player.health).toBe(13);
    expect(player.food).toBe(7);
    expect(player.oxygen).toBe(12);
    expect(player.heldItem).toBe('stone_pickaxe');
    expect(player.equipment['head']).toBe('iron_helmet');
    expect(player.facing).toBe('south');
  });

  it('detects standing in water', () => {
    const blocks = new Map([
      [key(0, 64, 0), 'water'],
      [key(0, 65, 0), 'water'],
    ]);
    const { observer } = buildObserver({ blocks, position: new Vec3(0.5, 64, 0.5) });
    expect(observer.observe().player.isInWater).toBe(true);
  });

  it('reports weather and what the bot is standing on', () => {
    const blocks = new Map([[key(0, 63, 0), 'grass_block']]);
    const { observer } = buildObserver({ blocks, isRaining: true, thunderState: 0, position: new Vec3(0.5, 64, 0.5) });
    const environment = observer.observe().environment;
    expect(environment.weather).toBe('rain');
    expect(environment.standingOn).toBe('grass_block');
  });

  it('prefers thunder over rain', () => {
    const { observer } = buildObserver({ isRaining: true, thunderState: 1 });
    expect(observer.observe().environment.weather).toBe('thunder');
  });

  it('labels the time of day', () => {
    expect(describeTimeOfDay(0)).toBe('dawn');
    expect(describeTimeOfDay(6_000)).toBe('noon');
    expect(describeTimeOfDay(13_500)).toBe('night');
    expect(describeTimeOfDay(23_500)).toBe('dawn');
    // Wraps around rather than throwing on an out-of-range value.
    expect(describeTimeOfDay(30_000)).toBe('noon'); // 30000 % 24000 = 6000
    expect(describeTimeOfDay(-1_000)).toBe('dawn'); // wraps to 23000
  });

  it('increments the tick counter on each observation', () => {
    const { observer } = buildObserver();
    expect(observer.observe().tick).toBe(1);
    expect(observer.observe().tick).toBe(2);
  });
});

describe('prompt-level state compression', () => {
  it('drops empty collections and no-op fields', () => {
    const { observer } = buildObserver();
    const compressed = compressState(observer.observe());

    expect(compressed['nearbyBlocks']).toBeUndefined();
    expect(compressed['entities']).toBeUndefined();
    expect(compressed['THREATS']).toBeUndefined();
    expect(compressed['inventory']).toBe('empty');
    // Full oxygen is the default, so it is not worth prompt tokens.
    expect((compressed['player'] as Record<string, unknown>)['oxygen']).toBeUndefined();
  });

  it('keeps a full state compact enough to prompt with', () => {
    const blocks = fillBlocks('stone', [-6, 58, -6], [6, 64, 6]);
    for (let i = 0; i < 20; i += 1) blocks.set(key(i % 8, 65, 3), 'oak_log');

    const { observer } = buildObserver({
      blocks,
      position: new Vec3(0.5, 64, 0.5),
      inventory: Array.from({ length: 12 }, (_, i) => ({
        name: ['oak_log', 'stone', 'dirt', 'coal'][i % 4]!,
        type: i % 4,
        count: 10 + i,
        slot: 9 + i,
      })),
      entities: Array.from({ length: 10 }, (_, i) => ({
        id: 100 + i,
        name: 'zombie',
        type: 'hostile',
        position: new Vec3(i, 64, 2),
        height: 1.95,
        width: 0.6,
        health: 20,
      })),
    });

    const json = JSON.stringify(compressState(observer.observe()));
    // Roughly 1 token per 4 characters: this keeps one observation well under 2k tokens.
    expect(json.length).toBeLessThan(6_000);
    expect(json).toContain('THREATS');
  });
});
