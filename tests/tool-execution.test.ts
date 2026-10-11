import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('mineflayer-pathfinder', async () => {
  const mock = await import('./helpers/pathfinder-mock.js');
  return mock.pathfinderMockModule();
});

import type { MockBotOptions } from './helpers/mock-bot.js';
import type { ToolResult } from '../src/types.js';

const { BlockActions } = await import('../src/minecraft/blocks.js');
const { CombatController } = await import('../src/minecraft/combat.js');
const { CraftingManager } = await import('../src/minecraft/crafting.js');
const { InventoryManager } = await import('../src/minecraft/inventory.js');
const { MovementController } = await import('../src/minecraft/movement.js');
const { WorldObserver } = await import('../src/minecraft/observer.js');
const { GameRegistry } = await import('../src/minecraft/registry.js');
const { createToolRegistry } = await import('../src/tools/index.js');
const { asBot, createMockBot, key } = await import('./helpers/mock-bot.js');
const { testConfig } = await import('./helpers/fixtures.js');
const { getLogger } = await import('../src/utils/logger.js');

const VERSION = '1.21.4';

/**
 * Exercises the tool adapter layer end to end: schema defaults, argument
 * mapping, and the call into the underlying manager, all against a fake bot.
 */
function harness(options: MockBotOptions = {}, env: Record<string, string> = {}) {
  const bot = createMockBot({ version: VERSION, position: new Vec3(0.5, 64, 0.5), ...options });
  const registry = new GameRegistry(VERSION);
  const cfg = testConfig(env).agent;
  const movement = new MovementController(asBot(bot), cfg);
  const inventory = new InventoryManager(asBot(bot), registry, movement);
  const combat = new CombatController(asBot(bot), registry, movement);
  const blocks = new BlockActions(asBot(bot), registry, movement, inventory);
  const crafting = new CraftingManager(asBot(bot), registry, movement, inventory);
  const observer = new WorldObserver(asBot(bot), registry, cfg);
  const tools = createToolRegistry();

  const controller = new AbortController();
  const run = (name: string, args: unknown): Promise<ToolResult> =>
    tools.execute(name, args, {
      bot: asBot(bot),
      registry,
      observer,
      movement,
      inventory,
      combat,
      blocks,
      crafting,
      cfg,
      log: getLogger(),
      signal: controller.signal,
    });

  return { bot, run, controller, tools, cfg };
}

describe('observe tool', () => {
  it('returns a digest without a focus', async () => {
    const { run } = harness();
    const result = await run('observe', {});

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data['position']).toEqual({ x: 0.5, y: 64, z: 0.5 });
    expect(data['focus']).toBeUndefined();
  });

  it('echoes the focus back when given', async () => {
    const { run } = harness();
    const result = await run('observe', { focus: 'looking for iron' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>)['focus']).toBe('looking for iron');
  });

  it('summarises threats', async () => {
    const { run } = harness({
      entities: [
        { id: 3, name: 'zombie', type: 'hostile', position: new Vec3(5, 64, 0), height: 1.95, width: 0.6 },
      ],
    });

    const result = await run('observe', {});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { threats: string[] }).threats[0]).toContain('zombie');
  });
});

describe('movement tools', () => {
  it('move_to passes the arrival tolerance through', async () => {
    const { bot, run } = harness();
    const result = await run('move_to', { x: 20, y: 64, z: 0, range: 4 });

    expect(result.success).toBe(true);
    expect(bot.__calls).toContain('pathfinder.goto');
  });

  it('move_to enforces the distance limit', async () => {
    const { run } = harness({}, { MAX_MOVE_DISTANCE: '16' });
    expect(await run('move_to', { x: 200, y: 64, z: 0 })).toMatchObject({
      success: false,
      error: 'TARGET_TOO_FAR',
    });
  });

  it('look_at accepts a point, an entity or raw angles', async () => {
    const { run } = harness({
      entities: [{ id: 8, name: 'cow', type: 'animal', position: new Vec3(3, 64, 0), height: 1.4, width: 0.9 }],
    });

    expect((await run('look_at', { x: 1, y: 64, z: 1 })).success).toBe(true);
    expect((await run('look_at', { entity_id: 8 })).success).toBe(true);
    expect((await run('look_at', { yaw: 1, pitch: 0 })).success).toBe(true);
  });

  it('look_at rejects an empty target at the schema layer', async () => {
    const { run } = harness();
    expect(await run('look_at', {})).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' });
  });

  it('jump defaults to one jump and clears the control state', async () => {
    const { bot, run } = harness();
    const result = await run('jump', {});

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { jumps: number }).jumps).toBe(1);
    expect(bot.getControlState('jump')).toBe(false);
  });

  it('jump repeats when asked', async () => {
    const { run } = harness();
    const result = await run('jump', { count: 3 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { jumps: number }).jumps).toBe(3);
  });

  it('sneak toggles the control state', async () => {
    const { bot, run } = harness();
    expect((await run('sneak', { enabled: true })).success).toBe(true);
    expect(bot.getControlState('sneak')).toBe(true);
    await run('sneak', { enabled: false });
    expect(bot.getControlState('sneak')).toBe(false);
  });

  it('sneak requires the enabled flag', async () => {
    const { run } = harness();
    expect(await run('sneak', {})).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' });
  });

  it('sprint toggles, but refuses when too hungry to sprint', async () => {
    const { bot, run } = harness({ food: 20 });
    expect((await run('sprint', { enabled: true })).success).toBe(true);
    expect(bot.getControlState('sprint')).toBe(true);

    bot.food = 5;
    const refused = await run('sprint', { enabled: true });
    expect(refused).toMatchObject({ success: false, error: 'UNSAFE' });
    if (refused.success) return;
    expect(refused.details).toContain('eat first');
  });

  it('sprint can always be turned off', async () => {
    const { run } = harness({ food: 3 });
    expect((await run('sprint', { enabled: false })).success).toBe(true);
  });

  it('wait waits and reports the duration', async () => {
    const { run } = harness();
    const startedAt = Date.now();
    const result = await run('wait', { seconds: 0.3, reason: 'letting the rain pass' });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { reason: string }).reason).toBe('letting the rain pass');
  });

  it('wait aborts early on a safety interrupt', async () => {
    const { run, controller } = harness();
    setTimeout(() => controller.abort(), 60);

    const result = await run('wait', { seconds: 10 });
    expect(result).toMatchObject({ success: false, error: 'ABORTED' });
  });

  it('wait never outlives its own budget', async () => {
    const { run } = harness({}, { MAX_ACTION_TIMEOUT_MS: '1500' });
    const startedAt = Date.now();
    const result = await run('wait', { seconds: 20 });

    expect(result.success).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('world tools', () => {
  it('mine defaults to one block and collects by default', async () => {
    const { bot, run } = harness({ blocks: new Map([[key(2, 64, 0), 'oak_log']]) });
    const result = await run('mine', { block: 'oak_log' });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { minedCount: number; requested: number };
    expect(data.minedCount).toBe(1);
    expect(data.requested).toBe(1);
    expect(bot.__calls).toContain('dig');
  });

  it('mine repeats up to count for a named block', async () => {
    const blocks = new Map([
      [key(2, 64, 0), 'oak_log'],
      [key(3, 64, 0), 'oak_log'],
      [key(4, 64, 0), 'oak_log'],
    ]);
    const { bot, run } = harness({ blocks });

    // Each dig removes the block, as a server would.
    bot.dig = async (block) => {
      const target = block as { position: { x: number; y: number; z: number } };
      bot.__blocks.delete(key(target.position.x, target.position.y, target.position.z));
      bot.__calls.push('dig');
    };

    const result = await run('mine', { block: 'oak_log', count: 3, collect: false });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { minedCount: number }).minedCount).toBe(3);
  });

  it('mine ignores count when an exact position is given', async () => {
    const { run } = harness({ blocks: new Map([[key(2, 64, 0), 'stone']]) });
    const result = await run('mine', { x: 2, y: 64, z: 0, count: 5, collect: false });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { requested: number }).requested).toBe(1);
  });

  it('mine reports partial progress when a later block fails', async () => {
    const blocks = new Map([[key(2, 64, 0), 'oak_log']]);
    const { bot, run } = harness({ blocks });
    bot.dig = async (block) => {
      const target = block as { position: { x: number; y: number; z: number } };
      bot.__blocks.delete(key(target.position.x, target.position.y, target.position.z));
    };

    const result = await run('mine', { block: 'oak_log', count: 4, collect: false });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { minedCount: number; stoppedEarly?: string };
    expect(data.minedCount).toBe(1);
    expect(data.stoppedEarly).toContain('BLOCK_NOT_FOUND');
  });

  it('mine returns the failure when nothing could be mined at all', async () => {
    const { run } = harness();
    expect(await run('mine', { block: 'oak_log' })).toMatchObject({
      success: false,
      error: 'BLOCK_NOT_FOUND',
    });
  });

  it('mine rejects a name that is not an identifier', async () => {
    const { run } = harness();
    expect(await run('mine', { block: 'oak log!' })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });

  it('place_block forwards to the block layer', async () => {
    const { bot, run } = harness({
      blocks: new Map([[key(1, 63, 0), 'stone']]),
      inventory: [{ name: 'cobblestone', type: 4, count: 10, slot: 9 }],
    });

    const result = await run('place_block', { item: 'cobblestone', x: 1, y: 64, z: 0 });
    expect(result.success).toBe(true);
    expect(bot.__calls).toContain('placeBlock');
  });

  it('place_block requires all coordinates', async () => {
    const { run } = harness();
    expect(await run('place_block', { item: 'cobblestone', x: 1, y: 64 })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });

  it('interact forwards to the block layer', async () => {
    const { bot, run } = harness({ blocks: new Map([[key(2, 64, 0), 'oak_door']]) });
    const result = await run('interact', { block: 'oak_door' });

    expect(result.success).toBe(true);
    expect(bot.__calls).toContain('activateBlock');
  });

  it('interact accepts a bare position', async () => {
    const { run } = harness({ blocks: new Map([[key(2, 64, 0), 'lever']]) });
    expect((await run('interact', { x: 2, y: 64, z: 0 })).success).toBe(true);
  });

  it('interact requires a target', async () => {
    const { run } = harness();
    expect(await run('interact', {})).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' });
  });
});

describe('inventory tools', () => {
  it('equip defaults to the hand', async () => {
    const { bot, run } = harness({ inventory: [{ name: 'iron_sword', type: 5, count: 1, slot: 9 }] });
    expect((await run('equip', { item: 'iron_sword' })).success).toBe(true);
    expect(bot.__calls).toContain('equip:iron_sword');
  });

  it('equip accepts armour destinations and rejects invented ones', async () => {
    const { run } = harness({ inventory: [{ name: 'iron_helmet', type: 6, count: 1, slot: 9 }] });
    expect((await run('equip', { item: 'iron_helmet', destination: 'head' })).success).toBe(true);
    expect(await run('equip', { item: 'iron_helmet', destination: 'hat' })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });

  it('eat picks a food when none is named', async () => {
    const { bot, run } = harness({ food: 10, inventory: [{ name: 'bread', type: 297, count: 2, slot: 9 }] });
    expect((await run('eat', {})).success).toBe(true);
    expect(bot.__calls).toContain('consume');
  });

  it('eat honours an explicit choice', async () => {
    const { run } = harness({
      food: 10,
      inventory: [
        { name: 'bread', type: 297, count: 1, slot: 9 },
        { name: 'apple', type: 260, count: 1, slot: 10 },
      ],
    });

    const result = await run('eat', { item: 'apple' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { ate: string }).ate).toBe('apple');
  });

  it('collect defaults its radius and cap', async () => {
    const { run } = harness();
    // Nothing nearby, but the defaults must still produce a valid call.
    expect(await run('collect', {})).toMatchObject({ success: false, error: 'TARGET_NOT_FOUND' });
  });

  it('collect rejects an out-of-range radius', async () => {
    const { run } = harness();
    expect(await run('collect', { radius: 500 })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });

  it('craft defaults the count to one', async () => {
    const { bot, run } = harness();
    let requestedMin: number | null = null;
    bot.recipesFor = (_id, _meta, min) => {
      requestedMin = min as number;
      return [];
    };

    await run('craft', { item: 'stick' });
    expect(requestedMin).toBe(1);
  });

  it('craft forwards an explicit count', async () => {
    const { bot, run } = harness();
    let requestedMin: number | null = null;
    bot.recipesFor = (_id, _meta, min) => {
      requestedMin = min as number;
      return [];
    };

    await run('craft', { item: 'stick', count: 8 });
    expect(requestedMin).toBe(8);
  });

  it('craft rejects a count above the stack limit', async () => {
    const { run } = harness();
    expect(await run('craft', { item: 'stick', count: 500 })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });

  it('smelt forwards an explicit fuel choice', async () => {
    const { run } = harness({
      inventory: [
        { name: 'raw_iron', type: 700, count: 2, slot: 9 },
        { name: 'coal', type: 263, count: 4, slot: 10 },
      ],
    });

    // No furnace nearby, but the fuel must validate first.
    const result = await run('smelt', { item: 'raw_iron', count: 2, fuel: 'coal' });
    expect(result).toMatchObject({ success: false, error: 'FURNACE_REQUIRED' });
  });

  it('smelt rejects an invalid count', async () => {
    const { run } = harness();
    expect(await run('smelt', { item: 'raw_iron', count: 0 })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });
});

describe('combat tool', () => {
  it('attacks a hostile resolved by name', async () => {
    const { bot, run } = harness({
      entities: [
        { id: 40, name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0), height: 1.95, width: 0.6, isValid: true },
      ],
    });

    let swings = 0;
    bot.attack = () => {
      swings += 1;
      if (swings >= 2) bot.entities['40']!.isValid = false;
    };

    const result = await run('attack', { entity: 'zombie', max_swings: 5 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { killed: boolean }).killed).toBe(true);
  });

  it('lists nearby hostiles when the target is missing', async () => {
    const { run } = harness({
      entities: [
        { id: 41, name: 'skeleton', type: 'hostile', position: new Vec3(5, 64, 0), height: 1.99, width: 0.6, isValid: true },
      ],
    });

    const result = await run('attack', { entity: 'creeper' });
    expect(result).toMatchObject({ success: false, error: 'ENTITY_NOT_FOUND' });
    if (result.success) return;
    expect(result.details).toContain('skeleton');
    expect(result.details).toContain('id 41');
  });

  it('refuses to attack a player', async () => {
    const { run } = harness({
      entities: [
        { id: 42, name: 'player', username: 'Steve', type: 'player', position: new Vec3(2, 64, 0), height: 1.8, width: 0.6, isValid: true },
      ],
    });

    const result = await run('attack', { entity_id: 42 });
    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
    if (result.success) return;
    expect(result.details).toContain('Steve');
  });

  it('requires a target', async () => {
    const { run } = harness();
    expect(await run('attack', {})).toMatchObject({ success: false, error: 'INVALID_ARGUMENTS' });
  });

  it('rejects an absurd swing budget', async () => {
    const { run } = harness();
    expect(await run('attack', { entity: 'zombie', max_swings: 1_000 })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });
});

describe('say tool', () => {
  /** The mock bot has no chat senders; record what would have gone out. */
  function talker() {
    const h = harness();
    const said: string[] = [];
    const whispered: Array<{ to: string; text: string }> = [];
    (h.bot as unknown as { chat: (text: string) => void }).chat = (text) => said.push(text);
    (h.bot as unknown as { whisper: (to: string, text: string) => void }).whisper = (to, text) =>
      whispered.push({ to, text });
    return { ...h, said, whispered };
  }

  it('speaks in public chat', async () => {
    const { run, said } = talker();
    const result = await run('say', { message: 'heading to the mine' });

    expect(result).toMatchObject({ success: true });
    expect(said).toEqual(['heading to the mine']);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>)['channel']).toBe('public');
  });

  it('whispers when given a recipient', async () => {
    const { run, whispered, said } = talker();
    const result = await run('say', { message: 'at 164,82,-31', to: 'bugraa' });

    expect(result).toMatchObject({ success: true });
    expect(whispered).toEqual([{ to: 'bugraa', text: 'at 164,82,-31' }]);
    expect(said).toEqual([]);
  });

  it('refuses a message that would run as a server command', async () => {
    const { run, said } = talker();
    expect(await run('say', { message: '/kill @e' })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
    expect(said).toEqual([]);
  });

  it('collapses newlines so one message cannot become two chat lines', async () => {
    const { run, said } = talker();
    await run('say', { message: 'first line\nsecond line' });
    expect(said).toEqual(['first line second line']);
  });

  it('rejects an empty message and an over-long one', async () => {
    const { run } = talker();
    expect(await run('say', { message: '   ' })).toMatchObject({ success: false });
    expect(await run('say', { message: 'x'.repeat(400) })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });

  it('rejects a recipient that is not a valid username', async () => {
    const { run } = talker();
    expect(await run('say', { message: 'hi', to: 'not a name' })).toMatchObject({
      success: false,
      error: 'INVALID_ARGUMENTS',
    });
  });

  it('reports a failing chat sender instead of throwing', async () => {
    const { run, bot } = talker();
    (bot as unknown as { chat: () => void }).chat = () => {
      throw new Error('chat is disabled');
    };
    expect(await run('say', { message: 'hello' })).toMatchObject({
      success: false,
      error: 'MINEFLAYER_ERROR',
    });
  });
});
