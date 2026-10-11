import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('mineflayer-pathfinder', async () => {
  const mock = await import('./helpers/pathfinder-mock.js');
  return mock.pathfinderMockModule();
});

import type { MockBotOptions } from './helpers/mock-bot.js';

const { BlockActions, withTimeout, ActionTimeout } = await import('../src/minecraft/blocks.js');
const { CombatController } = await import('../src/minecraft/combat.js');
const { CraftingManager } = await import('../src/minecraft/crafting.js');
const { InventoryManager } = await import('../src/minecraft/inventory.js');
const { MovementController } = await import('../src/minecraft/movement.js');
const { GameRegistry } = await import('../src/minecraft/registry.js');
const { asBot, createMockBot, key } = await import('./helpers/mock-bot.js');
const { testConfig } = await import('./helpers/fixtures.js');

const VERSION = '1.21.4';

function build(options: MockBotOptions = {}, env: Record<string, string> = {}) {
  const bot = createMockBot({ version: VERSION, position: new Vec3(0.5, 64, 0.5), ...options });
  const registry = new GameRegistry(VERSION);
  const cfg = testConfig(env).agent;
  const movement = new MovementController(asBot(bot), cfg);
  const inventory = new InventoryManager(asBot(bot), registry, movement);
  const combat = new CombatController(asBot(bot), registry, movement);
  const blocks = new BlockActions(asBot(bot), registry, movement, inventory);
  const crafting = new CraftingManager(asBot(bot), registry, movement, inventory);
  return { bot, registry, cfg, movement, inventory, combat, blocks, crafting };
}

/* ─────────────────────────────── mining ───────────────────────────────── */

describe('mining', () => {
  it('mines the nearest block of a named type', async () => {
    const { bot, blocks } = build({ blocks: new Map([[key(2, 64, 0), 'oak_log']]) });

    const result = await blocks.mine({ blockName: 'oak_log' }, {
      searchRadius: 12,
      timeoutMs: 10_000,
      collectDrops: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.block).toBe('oak_log');
    expect(result.data.position).toEqual({ x: 2, y: 64, z: 0 });
    expect(bot.__calls).toContain('dig');
  });

  it('refuses to break protected blocks', async () => {
    const { blocks } = build({ blocks: new Map([[key(1, 64, 0), 'bedrock']]) });

    const result = await blocks.mine({ position: { x: 1, y: 64, z: 0 } }, {
      searchRadius: 12,
      timeoutMs: 5_000,
      collectDrops: false,
    });

    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
    if (result.success) return;
    expect(result.details).toContain('bedrock');
  });

  it('reports air rather than pretending to mine it', async () => {
    const { blocks } = build();
    const result = await blocks.mine({ position: { x: 1, y: 64, z: 0 } }, {
      searchRadius: 12,
      timeoutMs: 5_000,
      collectDrops: false,
    });

    expect(result).toMatchObject({ success: false, error: 'BLOCK_NOT_FOUND' });
    if (result.success) return;
    expect(result.details).toContain('it is air');
  });

  it('rejects an unknown block name with suggestions', async () => {
    const { blocks } = build();
    const result = await blocks.mine({ blockName: 'iron_orr' }, {
      searchRadius: 12,
      timeoutMs: 5_000,
      collectDrops: false,
    });

    expect(result).toMatchObject({ success: false, error: 'UNKNOWN_BLOCK' });
    if (result.success) return;
    expect(result.details).toContain('iron_ore');
  });

  it('reports a mismatch when the world has changed under the model', async () => {
    const { blocks } = build({ blocks: new Map([[key(1, 64, 0), 'stone']]) });

    const result = await blocks.mine({ blockName: 'oak_log', position: { x: 1, y: 64, z: 0 } }, {
      searchRadius: 12,
      timeoutMs: 5_000,
      collectDrops: false,
    });

    expect(result).toMatchObject({ success: false, error: 'BLOCK_NOT_FOUND' });
    if (result.success) return;
    expect(result.details).toContain('but found stone');
  });

  it('reports when no such block is in range', async () => {
    const { blocks } = build();
    const result = await blocks.mine({ blockName: 'diamond_ore' }, {
      searchRadius: 12,
      timeoutMs: 5_000,
      collectDrops: false,
    });

    expect(result).toMatchObject({ success: false, error: 'BLOCK_NOT_FOUND' });
    if (result.success) return;
    expect(result.details).toContain('within 12 blocks');
  });

  it('equips the best available tool before digging', async () => {
    const { bot, blocks } = build({
      blocks: new Map([[key(2, 64, 0), 'iron_ore']]),
      inventory: [
        { name: 'wooden_pickaxe', type: 1, count: 1, slot: 9 },
        { name: 'stone_pickaxe', type: 2, count: 1, slot: 10 },
      ],
    });

    const result = await blocks.mine({ blockName: 'iron_ore' }, {
      searchRadius: 12,
      timeoutMs: 10_000,
      collectDrops: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Stone beats wood for iron ore.
    expect(result.data.tool).toBe('stone_pickaxe');
    expect(bot.__calls).toContain('equip:stone_pickaxe');
  });

  it('times out a dig that never completes and stops digging', async () => {
    const { bot, blocks } = build({ blocks: new Map([[key(2, 64, 0), 'obsidian']]) });
    bot.dig = () => new Promise(() => undefined);

    const result = await blocks.mine({ blockName: 'obsidian' }, {
      searchRadius: 12,
      timeoutMs: 600,
      collectDrops: false,
    });

    expect(result).toMatchObject({ success: false, error: 'TIMEOUT' });
    expect(bot.__calls).toContain('stopDigging');
  });

  it('surfaces a Mineflayer dig error', async () => {
    const { bot, blocks } = build({ blocks: new Map([[key(2, 64, 0), 'stone']]) });
    bot.dig = async () => {
      throw new Error('server rejected the dig');
    };

    const result = await blocks.mine({ blockName: 'stone' }, {
      searchRadius: 12,
      timeoutMs: 5_000,
      collectDrops: false,
    });

    expect(result).toMatchObject({ success: false, error: 'MINEFLAYER_ERROR' });
    if (result.success) return;
    expect(result.details).toContain('server rejected the dig');
  });

  it('requires a block name or a position', async () => {
    const { blocks } = build();
    const result = await blocks.mine({}, { searchRadius: 12, timeoutMs: 5_000, collectDrops: false });
    expect(result).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' });
  });
});

/* ─────────────────────────────── placing ──────────────────────────────── */

describe('placing blocks', () => {
  it('places against a solid neighbour', async () => {
    const { bot, blocks } = build({
      blocks: new Map([[key(1, 63, 0), 'stone']]),
      inventory: [{ name: 'crafting_table', type: 100, count: 1, slot: 9 }],
    });

    const result = await blocks.place('crafting_table', { x: 1, y: 64, z: 0 }, { timeoutMs: 8_000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.against.block).toBe('stone');
    expect(result.data.against.position).toEqual({ x: 1, y: 63, z: 0 });
    expect(bot.__calls).toContain('placeBlock');
  });

  it('refuses when the item is not in the inventory', async () => {
    const { blocks } = build({ blocks: new Map([[key(1, 63, 0), 'stone']]) });
    const result = await blocks.place('crafting_table', { x: 1, y: 64, z: 0 }, { timeoutMs: 5_000 });

    expect(result).toMatchObject({ success: false, error: 'ITEM_NOT_FOUND' });
  });

  it('refuses to overwrite an existing block', async () => {
    const { blocks } = build({
      blocks: new Map([
        [key(1, 63, 0), 'stone'],
        [key(1, 64, 0), 'stone'],
      ]),
      inventory: [{ name: 'crafting_table', type: 100, count: 1, slot: 9 }],
    });

    const result = await blocks.place('crafting_table', { x: 1, y: 64, z: 0 }, { timeoutMs: 5_000 });

    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
    if (result.success) return;
    expect(result.details).toContain('already contains stone');
  });

  it('refuses when there is no surface to attach to', async () => {
    const { blocks } = build({
      inventory: [{ name: 'crafting_table', type: 100, count: 1, slot: 9 }],
    });

    const result = await blocks.place('crafting_table', { x: 1, y: 64, z: 0 }, { timeoutMs: 5_000 });

    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
    if (result.success) return;
    expect(result.details).toContain('No solid face');
  });

  it('rejects an unknown item', async () => {
    const { blocks } = build();
    const result = await blocks.place('crafting_tabel', { x: 1, y: 64, z: 0 }, { timeoutMs: 5_000 });

    expect(result).toMatchObject({ success: false, error: 'UNKNOWN_ITEM' });
    if (result.success) return;
    expect(result.details).toContain('crafting_table');
  });

  it('rejects an insane position', async () => {
    const { blocks } = build();
    const result = await blocks.place('stone', { x: 0, y: 99_999, z: 0 }, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
  });
});

/* ───────────────────────── interaction and looking ────────────────────── */

describe('interaction', () => {
  it('activates a nearby block', async () => {
    const { bot, blocks } = build({ blocks: new Map([[key(2, 64, 0), 'oak_door']]) });

    const result = await blocks.interact({ blockName: 'oak_door' }, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.block).toBe('oak_door');
    expect(bot.__calls).toContain('activateBlock');
  });

  it('surfaces an activation failure', async () => {
    const { bot, blocks } = build({ blocks: new Map([[key(2, 64, 0), 'lever']]) });
    bot.activateBlock = async () => {
      throw new Error('cannot use that');
    };

    const result = await blocks.interact({ position: { x: 2, y: 64, z: 0 } }, {
      searchRadius: 12,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ success: false, error: 'MINEFLAYER_ERROR' });
  });
});

describe('looking', () => {
  it('looks at a point', async () => {
    const { bot, blocks } = build();
    const result = await blocks.lookAt({ position: { x: 10, y: 64, z: 10 } });

    expect(result.success).toBe(true);
    expect(bot.__calls).toContain('lookAt');
  });

  it('looks at an entity', async () => {
    const { blocks } = build({
      entities: [
        { id: 12, name: 'cow', type: 'animal', position: new Vec3(3, 64, 0), height: 1.4, width: 0.9 },
      ],
    });

    const result = await blocks.lookAt({ entityId: 12 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.lookedAt).toBe('cow');
  });

  it('reports a missing entity', async () => {
    const { blocks } = build();
    expect(await blocks.lookAt({ entityId: 999 })).toMatchObject({
      success: false,
      error: 'ENTITY_NOT_FOUND',
    });
  });

  it('accepts an absolute yaw and pitch', async () => {
    const { blocks } = build();
    const result = await blocks.lookAt({ yaw: 1.5, pitch: 0.2 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.yaw).toBe(1.5);
  });

  it('requires some target', async () => {
    const { blocks } = build();
    expect(await blocks.lookAt({})).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' });
  });
});

/* ───────────────────────────── withTimeout ────────────────────────────── */

describe('withTimeout', () => {
  it('passes a value through when it resolves in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1_000, undefined, 'too slow')).resolves.toBe('done');
  });

  it('throws ActionTimeout and runs the cleanup', async () => {
    const cleanup = vi.fn();
    await expect(
      withTimeout(new Promise(() => undefined), 60, cleanup, 'dig took too long'),
    ).rejects.toBeInstanceOf(ActionTimeout);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('propagates the original rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('nope')), 1_000, undefined, 'too slow'),
    ).rejects.toThrow('nope');
  });
});

/* ──────────────────────────── inventory / eat ─────────────────────────── */

describe('equipping', () => {
  it('equips an item from the inventory', async () => {
    const { bot, inventory } = build({ inventory: [{ name: 'iron_sword', type: 5, count: 1, slot: 9 }] });

    const result = await inventory.equip('iron_sword', 'hand');
    expect(result.success).toBe(true);
    expect(bot.__calls).toContain('equip:iron_sword');
  });

  it('rejects an unknown item with suggestions', async () => {
    const { inventory } = build();
    const result = await inventory.equip('iron_swrod', 'hand');

    expect(result).toMatchObject({ success: false, error: 'UNKNOWN_ITEM' });
    if (result.success) return;
    expect(result.details).toContain('iron_sword');
  });

  it('reports what is actually carried when the item is missing', async () => {
    const { inventory } = build({ inventory: [{ name: 'dirt', type: 3, count: 10, slot: 9 }] });
    const result = await inventory.equip('iron_sword', 'hand');

    expect(result).toMatchObject({ success: false, error: 'ITEM_NOT_FOUND' });
    if (result.success) return;
    expect(result.details).toContain('dirt x10');
  });

  it('surfaces a Mineflayer equip failure', async () => {
    const { bot, inventory } = build({ inventory: [{ name: 'iron_sword', type: 5, count: 1, slot: 9 }] });
    bot.equip = async () => {
      throw new Error('slot is locked');
    };

    expect(await inventory.equip('iron_sword', 'hand')).toMatchObject({
      success: false,
      error: 'MINEFLAYER_ERROR',
    });
  });
});

describe('eating', () => {
  it('eats the smallest food that covers the deficit', async () => {
    const { bot, inventory } = build({
      food: 16,
      inventory: [
        { name: 'bread', type: 297, count: 3, slot: 9 },
        { name: 'cooked_beef', type: 364, count: 2, slot: 10 },
      ],
    });

    const result = await inventory.eat();

    expect(result.success).toBe(true);
    if (!result.success) return;
    // A 4-point deficit: bread (5) covers it; beef (8) would waste food.
    expect((result.data as { ate: string }).ate).toBe('bread');
    expect(bot.__calls).toContain('consume');
  });

  it('keeps golden apples for emergencies', async () => {
    const { inventory } = build({
      food: 4,
      inventory: [
        { name: 'golden_apple', type: 322, count: 1, slot: 9 },
        { name: 'bread', type: 297, count: 1, slot: 10 },
      ],
    });

    const result = await inventory.eat();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { ate: string }).ate).toBe('bread');
  });

  it('uses rotten flesh only as a last resort', async () => {
    const { inventory } = build({
      food: 4,
      inventory: [
        { name: 'rotten_flesh', type: 367, count: 5, slot: 9 },
        { name: 'bread', type: 297, count: 1, slot: 10 },
      ],
    });

    const result = await inventory.eat();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { ate: string }).ate).toBe('bread');
  });

  it('refuses to waste food on a full hunger bar', async () => {
    const { inventory } = build({ food: 20, inventory: [{ name: 'bread', type: 297, count: 1, slot: 9 }] });
    const result = await inventory.eat();

    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
    if (result.success) return;
    expect(result.details).toContain('already full');
  });

  it('reports when there is nothing edible', async () => {
    const { inventory } = build({ food: 10, inventory: [{ name: 'stone', type: 1, count: 20, slot: 9 }] });
    expect(await inventory.eat()).toMatchObject({ success: false, error: 'ITEM_NOT_FOUND' });
  });

  it('rejects a request to eat something inedible', async () => {
    const { inventory } = build({ food: 10, inventory: [{ name: 'stone', type: 1, count: 20, slot: 9 }] });
    expect(await inventory.eat('stone')).toMatchObject({ success: false, error: 'NOT_EDIBLE' });
  });

  it('honours an explicit food choice', async () => {
    const { inventory } = build({
      food: 10,
      inventory: [
        { name: 'bread', type: 297, count: 1, slot: 9 },
        { name: 'apple', type: 260, count: 1, slot: 10 },
      ],
    });

    const result = await inventory.eat('apple');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { ate: string }).ate).toBe('apple');
  });

  it('reports whether any food is carried', () => {
    expect(build({ inventory: [{ name: 'bread', type: 297, count: 1, slot: 9 }] }).inventory.hasFood()).toBe(true);
    expect(build({ inventory: [{ name: 'stone', type: 1, count: 1, slot: 9 }] }).inventory.hasFood()).toBe(false);
  });
});

describe('collecting drops', () => {
  it('walks to a dropped stack and reports the gain', async () => {
    const drop = {
      id: 50,
      name: 'item',
      type: 'object',
      position: new Vec3(3, 64, 0),
      height: 0.25,
      width: 0.25,
      getDroppedItem: () => ({ name: 'oak_log', count: 2 }),
    };
    const { bot, inventory } = build({ entities: [drop] });

    // Simulate the server granting the pickup while we walk.
    const originalGoto = bot.pathfinder.goto;
    bot.pathfinder.goto = async (goal) => {
      await originalGoto(goal);
      bot.inventory.slots[9] = { name: 'oak_log', type: 17, count: 2, slot: 9 };
    };

    const result = await inventory.collect({ radius: 12, maxItems: 3, timeoutMs: 8_000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.collected).toEqual([{ item: 'oak_log', count: 2 }]);
  });

  it('reports when nothing is on the ground', async () => {
    const { inventory } = build();
    const result = await inventory.collect({ radius: 12, maxItems: 3, timeoutMs: 3_000 });

    expect(result).toMatchObject({ success: false, error: 'TARGET_NOT_FOUND' });
  });

  it('filters by item name', async () => {
    const { inventory } = build({
      entities: [
        {
          id: 51,
          name: 'item',
          type: 'object',
          position: new Vec3(3, 64, 0),
          height: 0.25,
          width: 0.25,
          getDroppedItem: () => ({ name: 'dirt', count: 1 }),
        },
      ],
    });

    const result = await inventory.collect({ itemName: 'oak_log', radius: 12, maxItems: 3, timeoutMs: 3_000 });
    expect(result).toMatchObject({ success: false, error: 'TARGET_NOT_FOUND' });
    if (result.success) return;
    expect(result.details).toContain('oak_log');
  });

  it('rejects an unknown item filter', async () => {
    const { inventory } = build();
    expect(
      await inventory.collect({ itemName: 'oak_lag', radius: 12, maxItems: 3, timeoutMs: 3_000 }),
    ).toMatchObject({ success: false, error: 'UNKNOWN_ITEM' });
  });

  it('lists nearby drops nearest-first', () => {
    const { inventory } = build({
      entities: [
        { id: 60, name: 'item', type: 'object', position: new Vec3(8, 64, 0), height: 0.25, width: 0.25, getDroppedItem: () => ({ name: 'far', count: 1 }) },
        { id: 61, name: 'item', type: 'object', position: new Vec3(2, 64, 0), height: 0.25, width: 0.25, getDroppedItem: () => ({ name: 'near', count: 1 }) },
      ],
    });

    expect(inventory.nearbyDrops(20).map((drop) => drop.name)).toEqual(['near', 'far']);
  });
});

/* ──────────────────────────────── combat ──────────────────────────────── */

describe('combat target resolution', () => {
  it('resolves a target by entity id', () => {
    const { combat } = build({
      entities: [{ id: 70, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0), height: 1.95, width: 0.6 }],
    });
    expect(combat.resolveTarget({ entityId: 70 }, 24)?.id).toBe(70);
    expect(combat.resolveTarget({ entityId: 999 }, 24)).toBeNull();
  });

  it('resolves the nearest target by name', () => {
    const { combat } = build({
      entities: [
        { id: 71, name: 'zombie', type: 'hostile', position: new Vec3(10, 64, 0), height: 1.95, width: 0.6 },
        { id: 72, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0), height: 1.95, width: 0.6 },
      ],
    });
    expect(combat.resolveTarget({ entityName: 'zombie' }, 24)?.id).toBe(72);
  });

  it('respects the search radius', () => {
    const { combat } = build({
      entities: [{ id: 73, name: 'zombie', type: 'hostile', position: new Vec3(100, 64, 0), height: 1.95, width: 0.6 }],
    });
    expect(combat.resolveTarget({ entityName: 'zombie' }, 24)).toBeNull();
  });

  it('finds the nearest hostile and lists them in order', () => {
    const { combat } = build({
      entities: [
        { id: 74, name: 'skeleton', type: 'hostile', position: new Vec3(9, 64, 0), height: 1.99, width: 0.6 },
        { id: 75, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0), height: 1.95, width: 0.6 },
        { id: 76, name: 'cow', type: 'animal', position: new Vec3(1, 64, 0), height: 1.4, width: 0.9 },
      ],
    });

    expect(combat.nearestHostile(24)?.id).toBe(75);
    expect(combat.hostilesWithin(24).map((entity) => entity.id)).toEqual([75, 74]);
  });
});

describe('weapon selection', () => {
  it('prefers the best sword, then axes', () => {
    expect(
      build({
        inventory: [
          { name: 'wooden_sword', type: 1, count: 1, slot: 9 },
          { name: 'iron_sword', type: 2, count: 1, slot: 10 },
          { name: 'diamond_axe', type: 3, count: 1, slot: 11 },
        ],
      }).combat.bestWeapon()?.name,
    ).toBe('iron_sword');

    expect(
      build({ inventory: [{ name: 'stone_axe', type: 3, count: 1, slot: 9 }] }).combat.bestWeapon()?.name,
    ).toBe('stone_axe');

    expect(build({ inventory: [{ name: 'dirt', type: 3, count: 1, slot: 9 }] }).combat.bestWeapon()).toBeNull();
  });
});

describe('attacking', () => {
  it('closes the distance, swings and reports the kill', async () => {
    const zombie = {
      id: 80,
      name: 'zombie',
      type: 'hostile',
      position: new Vec3(2, 64, 0),
      height: 1.95,
      width: 0.6,
      health: 20,
      isValid: true,
    };
    const { bot, combat } = build({
      entities: [zombie],
      inventory: [{ name: 'iron_sword', type: 2, count: 1, slot: 9 }],
    });

    // Kill it after the second swing.
    let swings = 0;
    bot.attack = () => {
      bot.__calls.push('attack');
      swings += 1;
      if (swings >= 2) bot.entities['80']!.isValid = false;
    };

    const result = await combat.attack(bot.entities['80']!, { timeoutMs: 10_000, maxSwings: 12 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.swings).toBeGreaterThanOrEqual(2);
    expect(result.data.killed).toBe(true);
    expect(result.data.weapon).toBe('iron_sword');
  });

  it('stops at the swing budget', async () => {
    const { bot, combat } = build({
      entities: [
        { id: 81, name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0), height: 1.95, width: 0.6, health: 20, isValid: true },
      ],
    });

    const result = await combat.attack(bot.entities['81']!, { timeoutMs: 20_000, maxSwings: 3 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.swings).toBe(3);
    expect(result.data.killed).toBe(false);
  }, 20_000);

  it('aborts when the safety layer cancels', async () => {
    const { bot, combat } = build({
      entities: [
        { id: 82, name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0), height: 1.95, width: 0.6, isValid: true },
      ],
    });

    const controller = new AbortController();
    controller.abort();

    expect(
      await combat.attack(bot.entities['82']!, { timeoutMs: 5_000, maxSwings: 5, signal: controller.signal }),
    ).toMatchObject({ success: false, error: 'ABORTED' });
  });
});

describe('fleeing', () => {
  it('runs in the opposite direction from the threats', async () => {
    const { bot, combat } = build({
      entities: [
        { id: 90, name: 'zombie', type: 'hostile', position: new Vec3(5, 64, 0), height: 1.95, width: 0.6, isValid: true },
      ],
    });

    const result = await combat.flee([bot.entities['90']!], { minDistance: 10, timeoutMs: 8_000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.escapedFrom).toEqual(['zombie']);
    expect(bot.__calls).toContain('pathfinder.goto');
  });

  it('reports when there is nothing to flee from', async () => {
    const { combat } = build();
    expect(await combat.flee([], { minDistance: 10, timeoutMs: 5_000 })).toMatchObject({
      success: false,
      error: 'TARGET_NOT_FOUND',
    });
  });

  it('gives up when every escape route is blocked', async () => {
    const { bot, combat } = build({
      entities: [
        { id: 91, name: 'zombie', type: 'hostile', position: new Vec3(5, 64, 0), height: 1.95, width: 0.6, isValid: true },
      ],
    });
    bot.pathfinder.goto = async () => {
      const error = new Error('NoPath');
      error.name = 'NoPath';
      throw error;
    };

    expect(
      await combat.flee([bot.entities['91']!], { minDistance: 10, timeoutMs: 5_000 }),
    ).toMatchObject({ success: false, error: 'PATH_NOT_FOUND' });
  });
});

/* ─────────────────────────────── crafting ─────────────────────────────── */

describe('crafting', () => {
  it('rejects an unknown item with suggestions', async () => {
    const { crafting } = build();
    const result = await crafting.craft('wooden_pickaxr', 1, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result).toMatchObject({ success: false, error: 'UNKNOWN_ITEM' });
    if (result.success) return;
    expect(result.details).toContain('wooden_pickaxe');
  });

  it('reports NO_RECIPE for an item that cannot be crafted', async () => {
    const { crafting } = build();
    const result = await crafting.craft('diamond', 1, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result).toMatchObject({ success: false, error: 'NO_RECIPE' });
    if (result.success) return;
    expect(result.details).toContain('smelting');
  });

  it('reports a missing crafting table, with advice based on the inventory', async () => {
    const { bot, crafting } = build({ inventory: [{ name: 'crafting_table', type: 100, count: 1, slot: 9 }] });
    // A recipe exists, but only with a table.
    bot.recipesFor = (_id, _meta, _min, table) =>
      table ? [{ requiresTable: true, result: { count: 1 }, delta: [] }] : [];

    const result = await crafting.craft('wooden_pickaxe', 1, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result).toMatchObject({ success: false, error: 'CRAFTING_TABLE_REQUIRED' });
    if (result.success) return;
    expect(result.details).toContain('You are carrying one');
  });

  it('reports exactly which ingredients are missing', async () => {
    const { bot, crafting } = build();
    bot.recipesFor = () => [];
    bot.recipesAll = () => [
      {
        requiresTable: false,
        result: { count: 4 },
        delta: [
          { id: 43, metadata: null, count: -2 },
          { id: 879, metadata: null, count: 4 },
        ],
      },
    ];

    const result = await crafting.craft('stick', 4, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result).toMatchObject({ success: false, error: 'MISSING_INGREDIENTS' });
    if (result.success) return;
    expect(result.details).toContain('Still need:');
  });

  it('crafts through Mineflayer and reports what changed', async () => {
    const { bot, crafting } = build({ inventory: [{ name: 'oak_planks', type: 43, count: 4, slot: 9 }] });
    bot.recipesFor = () => [{ requiresTable: false, result: { count: 4 }, delta: [] }];
    bot.craft = async () => {
      bot.__calls.push('craft');
      bot.inventory.slots[9]!.count = 2;
      bot.inventory.slots[10] = { name: 'stick', type: 879, count: 4, slot: 10 };
    };

    const result = await crafting.craft('stick', 4, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.produced).toBe(4);
    expect(result.data.consumed).toEqual([{ item: 'oak_planks', count: 2 }]);
    expect(result.data.usedCraftingTable).toBe(false);
  });

  it('surfaces a Mineflayer craft failure', async () => {
    const { bot, crafting } = build();
    bot.recipesFor = () => [{ requiresTable: false, result: { count: 1 }, delta: [] }];
    bot.craft = async () => {
      throw new Error('window closed unexpectedly');
    };

    const result = await crafting.craft('stick', 1, { searchRadius: 12, timeoutMs: 8_000 });
    expect(result).toMatchObject({ success: false, error: 'MINEFLAYER_ERROR' });
  });

  it('waits for a slow server to credit the result instead of calling it a failure', async () => {
    const { bot, crafting } = build({ inventory: [{ name: 'oak_planks', type: 43, count: 4, slot: 9 }] });
    bot.recipesFor = () => [{ requiresTable: false, result: { count: 4 }, delta: [] }];
    // The server needs ten ticks to send the crafted stack; `craft()` itself
    // resolves immediately. A fixed four-tick settle reads that as "nothing
    // happened" and the retry burns another two planks.
    let ticks = 0;
    bot.waitForTicks = async (n: number) => {
      ticks += n;
      if (ticks >= 10) {
        bot.inventory.slots[9]!.count = 2;
        bot.inventory.slots[10] = { name: 'stick', type: 879, count: 4, slot: 10 };
      }
    };
    bot.craft = async () => {
      bot.__calls.push('craft');
    };

    const result = await crafting.craft('stick', 4, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.produced).toBe(4);
    expect(result.data.consumed).toEqual([{ item: 'oak_planks', count: 2 }]);
  });

  it('crafts one recipe at a time so a batch cannot strand the ingredients', async () => {
    const { bot, crafting } = build({ inventory: [{ name: 'oak_log', type: 20, count: 8, slot: 9 }] });
    bot.recipesFor = () => [{ requiresTable: false, result: { count: 4 }, delta: [] }];
    const batches: number[] = [];
    bot.craft = async (_recipe: unknown, count?: number) => {
      batches.push(count ?? 1);
      bot.inventory.slots[9]!.count -= 1;
      bot.inventory.slots[10] = { name: 'oak_planks', type: 43, count: 4 * batches.length, slot: 10 };
    };

    const result = await crafting.craft('oak_planks', 8, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result.success).toBe(true);
    // A single call carrying a count of 2 is what strands the stack.
    expect(batches).toEqual([1, 1]);
  });

  it('still reports failure when the result never turns up', async () => {
    const { bot, crafting } = build({ inventory: [{ name: 'oak_planks', type: 43, count: 4, slot: 9 }] });
    bot.recipesFor = () => [{ requiresTable: false, result: { count: 4 }, delta: [] }];
    bot.craft = async () => {
      bot.__calls.push('craft');
    };

    const result = await crafting.craft('stick', 4, { searchRadius: 12, timeoutMs: 200 });

    expect(result).toMatchObject({ success: false, error: 'MINEFLAYER_ERROR' });
    if (result.success) return;
    expect(result.details).toContain('stick');
  });

  it('does not mistake the client-side result slot for a delivered craft', async () => {
    const { bot, crafting } = build({ inventory: [{ name: 'oak_planks', type: 43, count: 8, slot: 9 }] });
    bot.recipesFor = () => [{ requiresTable: false, result: { count: 4 }, delta: [] }];
    // Mineflayer fakes the crafted stack into the result slot and the inputs
    // into the 2x2 grid before the server answers. Those slots are not
    // inventory: reading them as output reports a craft that never landed,
    // and the agent then spends a second set of ingredients retrying it.
    bot.craft = async () => {
      bot.__calls.push('craft');
      bot.inventory.slots[0] = { name: 'oak_planks', type: 43, count: 4, slot: 0 };
      bot.inventory.slots[1] = { name: 'oak_log', type: 20, count: 1, slot: 1 };
      bot.inventory.slots[3] = { name: 'oak_log', type: 20, count: 1, slot: 3 };
    };

    const result = await crafting.craft('oak_planks', 4, { searchRadius: 12, timeoutMs: 200 });

    expect(result).toMatchObject({ success: false, error: 'MINEFLAYER_ERROR' });
  });

  it('reports a craft that silently changed nothing', async () => {
    const { bot, crafting } = build();
    bot.recipesFor = () => [{ requiresTable: false, result: { count: 1 }, delta: [] }];

    const result = await crafting.craft('stick', 1, { searchRadius: 12, timeoutMs: 8_000 });
    expect(result).toMatchObject({ success: false, error: 'MINEFLAYER_ERROR' });
    if (result.success) return;
    expect(result.details).toContain('did not change');
  });
});

describe('smelting', () => {
  it('rejects an unknown item', async () => {
    const { crafting } = build();
    expect(await crafting.smelt('raw_irn', 1, { searchRadius: 12, timeoutMs: 8_000 })).toMatchObject({
      success: false,
      error: 'UNKNOWN_ITEM',
    });
  });

  it('reports when the input is not carried', async () => {
    const { crafting } = build();
    expect(await crafting.smelt('raw_iron', 1, { searchRadius: 12, timeoutMs: 8_000 })).toMatchObject({
      success: false,
      error: 'ITEM_NOT_FOUND',
    });
  });

  it('reports missing fuel before looking for a furnace', async () => {
    const { crafting } = build({ inventory: [{ name: 'raw_iron', type: 700, count: 3, slot: 9 }] });
    const result = await crafting.smelt('raw_iron', 3, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result).toMatchObject({ success: false, error: 'NO_FUEL' });
    if (result.success) return;
    expect(result.details).toContain('Coal, charcoal');
  });

  it('rejects an unusable explicit fuel', async () => {
    const { crafting } = build({
      inventory: [
        { name: 'raw_iron', type: 700, count: 3, slot: 9 },
        { name: 'coal', type: 263, count: 5, slot: 10 },
      ],
    });

    const result = await crafting.smelt('raw_iron', 3, {
      searchRadius: 12,
      timeoutMs: 8_000,
      fuelName: 'diamond',
    });

    expect(result).toMatchObject({ success: false, error: 'NO_FUEL' });
    if (result.success) return;
    expect(result.details).toContain('coal');
  });

  it('reports a missing furnace once fuel is available', async () => {
    const { crafting } = build({
      inventory: [
        { name: 'raw_iron', type: 700, count: 3, slot: 9 },
        { name: 'coal', type: 263, count: 5, slot: 10 },
      ],
    });

    const result = await crafting.smelt('raw_iron', 3, { searchRadius: 12, timeoutMs: 8_000 });

    expect(result).toMatchObject({ success: false, error: 'FURNACE_REQUIRED' });
    if (result.success) return;
    expect(result.details).toContain('Craft one from 8 cobblestone');
  });

  it('finds the nearest workstation of several kinds', () => {
    const { crafting } = build({
      blocks: new Map([
        [key(6, 64, 0), 'furnace'],
        [key(2, 64, 0), 'blast_furnace'],
      ]),
    });

    expect(crafting.findNearestBlock(['furnace', 'blast_furnace', 'smoker'], 12)?.name).toBe('blast_furnace');
    expect(crafting.findNearestBlock(['enchanting_table'], 12)).toBeNull();
  });
});
