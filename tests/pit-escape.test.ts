import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('mineflayer-pathfinder', async () => {
  const mock = await import('./helpers/pathfinder-mock.js');
  return mock.pathfinderMockModule();
});

import type { MockBotOptions } from './helpers/mock-bot.js';

const { BlockActions } = await import('../src/minecraft/blocks.js');
const { CombatController } = await import('../src/minecraft/combat.js');
const { InventoryManager } = await import('../src/minecraft/inventory.js');
const { MovementController } = await import('../src/minecraft/movement.js');
const { WorldObserver } = await import('../src/minecraft/observer.js');
const { GameRegistry } = await import('../src/minecraft/registry.js');
const { ReactiveSafety } = await import('../src/minecraft/safety.js');
const { asBot, createMockBot, key } = await import('./helpers/mock-bot.js');
const { testConfig } = await import('./helpers/fixtures.js');

const VERSION = '1.21.8';

function build(options: MockBotOptions = {}, env: Record<string, string> = {}) {
  const bot = createMockBot({ version: VERSION, position: new Vec3(0.5, 64, 0.5), ...options });
  const registry = new GameRegistry(VERSION);
  const cfg = testConfig(env).agent;
  const movement = new MovementController(asBot(bot), cfg);
  const inventory = new InventoryManager(asBot(bot), registry, movement);
  const combat = new CombatController(asBot(bot), registry, movement);
  const blocks = new BlockActions(asBot(bot), registry, movement, inventory);
  const observer = new WorldObserver(asBot(bot), registry, cfg);
  observer.setEnclosureProbe(() => blocks.describeEnclosure());
  const safety = new ReactiveSafety(asBot(bot), cfg, movement, combat, inventory);
  return { bot, blocks, observer, safety, movement, cfg };
}

/** Walls the bot in on all four sides to the given height. */
function digPit(depth: number): Map<string, string> {
  const blocks = new Map<string, string>();
  blocks.set(key(0, 63, 0), 'stone'); // floor under the bot
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as Array<[number, number]>) {
    for (let dy = 0; dy < depth; dy += 1) {
      blocks.set(key(dx, 64 + dy, dz), 'stone');
    }
  }
  return blocks;
}

describe('enclosure detection', () => {
  it('reports open ground as not enclosed', () => {
    const { blocks } = build({ blocks: new Map([[key(0, 63, 0), 'grass_block']]) });
    const enclosure = blocks.describeEnclosure();

    expect(enclosure.enclosed).toBe(false);
    expect(enclosure.blockedSides).toBe(0);
  });

  it('reports a two-deep pit as enclosed', () => {
    const { blocks } = build({ blocks: digPit(2) });
    const enclosure = blocks.describeEnclosure();

    expect(enclosure.enclosed).toBe(true);
    expect(enclosure.blockedSides).toBe(4);
    expect(enclosure.wallHeight).toBeGreaterThanOrEqual(2);
  });

  it('does not call a one-deep dip enclosed, since the bot can jump out', () => {
    const { blocks } = build({ blocks: digPit(1) });
    expect(blocks.describeEnclosure().enclosed).toBe(false);
  });

  it('does not call a corridor enclosed — two open sides are an exit', () => {
    const walls = new Map<string, string>([[key(0, 63, 0), 'stone']]);
    for (const dy of [0, 1]) {
      walls.set(key(1, 64 + dy, 0), 'stone');
      walls.set(key(-1, 64 + dy, 0), 'stone');
    }
    const { blocks } = build({ blocks: walls });

    const enclosure = blocks.describeEnclosure();
    expect(enclosure.blockedSides).toBe(2);
    expect(enclosure.enclosed).toBe(false);
  });

  it('notices a ceiling overhead', () => {
    const walls = digPit(2);
    walls.set(key(0, 66, 0), 'stone');
    const { blocks } = build({ blocks: walls });
    expect(blocks.describeEnclosure().hasCeiling).toBe(true);
  });

  it('surfaces the pit in the observation the model receives', () => {
    const { observer } = build({ blocks: digPit(3) });
    const state = observer.observe();

    expect(state.environment.stuckInPit).toBe(true);
    expect(state.environment.blockedSides).toBe(4);
  });
});

describe('pillar_up', () => {
  /** Makes placeBlock actually raise the bot, as the server would. */
  function wirePlacement(bot: ReturnType<typeof createMockBot>): void {
    bot.placeBlock = async (reference) => {
      const ref = reference as { position: { x: number; y: number; z: number } };
      bot.__setBlock(ref.position.x, ref.position.y + 1, ref.position.z, 'dirt');
      bot.__calls.push('placeBlock');
    };
    // The jump loop watches position.y, so raise it when jump is pressed.
    const originalSet = bot.setControlState.bind(bot);
    bot.setControlState = (control: string, state: boolean) => {
      originalSet(control, state);
      if (control === 'jump' && state) bot.entity.position.y += 1.2;
    };
  }

  it('builds upward and reports how far it got', async () => {
    const { bot, blocks } = build({
      blocks: digPit(3),
      inventory: [{ name: 'dirt', type: 9, count: 8, slot: 9 }],
    });
    wirePlacement(bot);

    const result = await blocks.pillarUp(3, { timeoutMs: 15_000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.placed).toBe(3);
    expect(result.data.block).toBe('dirt');
    expect(result.data.to.y).toBeGreaterThan(result.data.from.y);
    expect(bot.__calls.filter((call) => call === 'placeBlock')).toHaveLength(3);
  });

  it('picks the most expendable block rather than something valuable', async () => {
    const { bot, blocks } = build({
      blocks: digPit(3),
      inventory: [
        { name: 'diamond_block', type: 1, count: 4, slot: 9 },
        { name: 'oak_planks', type: 36, count: 4, slot: 10 },
        { name: 'dirt', type: 9, count: 4, slot: 11 },
      ],
    });
    wirePlacement(bot);

    const result = await blocks.pillarUp(1, { timeoutMs: 10_000 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.block).toBe('dirt');
  });

  it('honours an explicit block choice', async () => {
    const { bot, blocks } = build({
      blocks: digPit(3),
      inventory: [
        { name: 'dirt', type: 9, count: 4, slot: 9 },
        { name: 'cobblestone', type: 35, count: 4, slot: 10 },
      ],
    });
    wirePlacement(bot);

    const result = await blocks.pillarUp(1, { itemName: 'cobblestone', timeoutMs: 10_000 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.block).toBe('cobblestone');
  });

  it('never places more blocks than it holds', async () => {
    const { bot, blocks } = build({
      blocks: digPit(4),
      inventory: [{ name: 'dirt', type: 9, count: 2, slot: 9 }],
    });
    wirePlacement(bot);

    const result = await blocks.pillarUp(6, { timeoutMs: 15_000 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.placed).toBe(2);
  });

  it('reports having nothing to build with', async () => {
    const { blocks } = build({ blocks: digPit(3), inventory: [] });
    const result = await blocks.pillarUp(3, { timeoutMs: 5_000 });

    expect(result).toMatchObject({ success: false, error: 'ITEM_NOT_FOUND' });
    if (result.success) return;
    expect(result.details).toContain('dirt');
  });

  it('rejects an unknown block name', async () => {
    const { blocks } = build({ blocks: digPit(3), inventory: [{ name: 'dirt', type: 9, count: 4, slot: 9 }] });
    expect(await blocks.pillarUp(2, { itemName: 'dirtt', timeoutMs: 5_000 })).toMatchObject({
      success: false,
      error: 'UNKNOWN_ITEM',
    });
  });

  it('explains a blocked jump instead of hanging', async () => {
    const walls = digPit(3);
    walls.set(key(0, 66, 0), 'stone'); // ceiling: the jump cannot clear a block
    const { bot, blocks } = build({
      blocks: walls,
      inventory: [{ name: 'dirt', type: 9, count: 4, slot: 9 }],
    });
    // Jump does nothing, as if the bot were under a ceiling.
    bot.setControlState = (control: string, state: boolean) => {
      bot.__calls.push(`control:${control}=${state}`);
    };

    const result = await blocks.pillarUp(2, { timeoutMs: 6_000 });
    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
    if (result.success) return;
    expect(result.details).toContain('overhead');
  });

  it('refuses when there is no floor to build on', async () => {
    const { bot, blocks } = build({
      inventory: [{ name: 'dirt', type: 9, count: 4, slot: 9 }],
    });
    // No block below at all: the bot is falling.
    bot.__blocks.clear();

    const result = await blocks.pillarUp(2, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
  });

  it('stops when the safety layer aborts', async () => {
    const { bot, blocks } = build({
      blocks: digPit(3),
      inventory: [{ name: 'dirt', type: 9, count: 4, slot: 9 }],
    });
    wirePlacement(bot);

    const controller = new AbortController();
    controller.abort();

    const result = await blocks.pillarUp(3, { timeoutMs: 5_000, signal: controller.signal });
    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
  });
});

describe('reactive pit escape', () => {
  it('climbs out on its own after the bot sits walled in and idle', async () => {
    const { bot, blocks, safety } = build({
      blocks: digPit(3),
      inventory: [{ name: 'dirt', type: 9, count: 8, slot: 9 }],
    });

    let climbed = 0;
    safety.setPitEscape({
      isEnclosed: () => blocks.describeEnclosure().enclosed,
      climbOut: async () => {
        climbed += 1;
        return true;
      },
    });
    safety.attach();

    // Idle detection needs the bot to stay put past the threshold; drive the
    // clock rather than waiting 20 real seconds.
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 6; i += 1) bot.emit('physicsTick');
      vi.setSystemTime(Date.now() + 25_000);
      for (let i = 0; i < 6; i += 1) bot.emit('physicsTick');
    } finally {
      vi.useRealTimers();
    }

    // The reflex files its report only after climbOut resolves, so poll for it.
    let report = safety.consumeReport();
    await vi.waitFor(
      () => {
        report = safety.consumeReport();
        if (report.action === 'none') throw new Error('reflex has not reported yet');
      },
      { timeout: 3_000, interval: 25 },
    );

    expect(climbed).toBeGreaterThan(0);
    expect(report.action).toBe('escaped_pit');
    expect(report.detail).toContain('climb out');
    safety.detach();
  });

  it('leaves an unenclosed bot alone even when it is idle', async () => {
    const { bot, blocks, safety } = build({
      blocks: new Map([[key(0, 63, 0), 'grass_block']]),
      inventory: [{ name: 'dirt', type: 9, count: 8, slot: 9 }],
    });

    let climbed = 0;
    safety.setPitEscape({
      isEnclosed: () => blocks.describeEnclosure().enclosed,
      climbOut: async () => {
        climbed += 1;
        return true;
      },
    });
    safety.attach();

    vi.useFakeTimers();
    try {
      for (let i = 0; i < 6; i += 1) bot.emit('physicsTick');
      vi.setSystemTime(Date.now() + 30_000);
      for (let i = 0; i < 6; i += 1) bot.emit('physicsTick');
    } finally {
      vi.useRealTimers();
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(climbed).toBe(0);
    safety.detach();
  });

  it('does nothing without the escape hook wired up', () => {
    const { bot, safety } = build({ blocks: digPit(3) });
    safety.attach();
    for (let i = 0; i < 10; i += 1) bot.emit('physicsTick');
    expect(safety.consumeReport().action).toBe('none');
    safety.detach();
  });
});
