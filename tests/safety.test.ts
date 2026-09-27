import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import type { MockBotOptions } from './helpers/mock-bot.js';

vi.mock('mineflayer-pathfinder', async () => {
  const mock = await import('./helpers/pathfinder-mock.js');
  return mock.pathfinderMockModule();
});

const { CombatController } = await import('../src/minecraft/combat.js');
const { InventoryManager } = await import('../src/minecraft/inventory.js');
const { MovementController } = await import('../src/minecraft/movement.js');
const { GameRegistry } = await import('../src/minecraft/registry.js');
const { ReactiveSafety } = await import('../src/minecraft/safety.js');
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
  const safety = new ReactiveSafety(asBot(bot), cfg, movement, combat, inventory);
  return { bot, cfg, movement, inventory, combat, safety };
}

/** Drives enough physics ticks for the throttled checks to fire. */
function tick(bot: ReturnType<typeof createMockBot>, times = 6): void {
  for (let i = 0; i < times; i += 1) bot.emit('physicsTick');
}

describe('danger detection', () => {
  it('reports danger at or below the panic health threshold', () => {
    const { bot, safety } = build({ health: 20 }, { PANIC_HEALTH: '6' });
    expect(safety.isInDanger()).toBe(false);
    bot.health = 6;
    expect(safety.isInDanger()).toBe(true);
  });

  it('reports danger when lava is adjacent', () => {
    const { safety } = build({ blocks: new Map([[key(1, 64, 0), 'lava']]) });
    expect(safety.isInDanger()).toBe(true);
  });

  it('reports danger when a hostile is at close range', () => {
    const { safety } = build({
      entities: [
        { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0), height: 1.95, width: 0.6 },
      ],
    });
    expect(safety.isInDanger()).toBe(true);
  });

  it('is calm in a safe situation', () => {
    expect(build().safety.isInDanger()).toBe(false);
  });
});

describe('action interruption', () => {
  it('hands out a fresh signal per action and aborts the previous one', () => {
    const { safety } = build();
    const first = safety.createActionSignal();
    const second = safety.createActionSignal();

    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it('aborts the current action when lava appears mid-movement', () => {
    const { bot, safety, movement } = build();
    // Pretend a path is in flight, which is when the lava guard applies.
    bot.pathfinder.isMoving = () => true;
    const signal = safety.createActionSignal();
    safety.attach();

    bot.__setBlock(1, 64, 0, 'lava');
    tick(bot);

    expect(signal.aborted).toBe(true);
    expect(bot.__calls).toContain('pathfinder.stop');
    expect(safety.consumeReport().action).toBe('stopped_at_lava');
    safety.detach();
    movement.stop();
  });

  it('leaves the action alone when nothing is wrong', () => {
    const { bot, safety } = build();
    const signal = safety.createActionSignal();
    safety.attach();

    tick(bot, 20);

    expect(signal.aborted).toBe(false);
    expect(safety.consumeReport().action).toBe('none');
    safety.detach();
  });

  it('interrupts for a point-blank hostile only when health is already low', () => {
    const { bot, safety } = build(
      {
        health: 5,
        entities: [
          { id: 7, name: 'creeper', type: 'hostile', position: new Vec3(2, 64, 0), height: 1.7, width: 0.6 },
        ],
      },
      { PANIC_HEALTH: '6', CRITICAL_HEALTH: '2' },
    );
    const signal = safety.createActionSignal();
    safety.attach();

    tick(bot);

    expect(signal.aborted).toBe(true);
    expect(safety.consumeReport().action).toBe('interrupted_for_threat');
    safety.detach();
  });
});

describe('automatic eating', () => {
  it('eats when hunger drops below the configured level', async () => {
    const { bot, safety } = build(
      { food: 10, inventory: [{ name: 'bread', type: 297, count: 3, slot: 9 }] },
      { AUTO_EAT_FOOD_LEVEL: '14' },
    );
    safety.attach();

    tick(bot);
    await vi.waitFor(() => expect(bot.__calls).toContain('consume'), { timeout: 2_000 });

    expect(bot.__calls).toContain('equip:bread');
    expect(safety.consumeReport().action).toBe('ate_food');
    safety.detach();
  });

  it('does not eat when there is no food', async () => {
    const { bot, safety } = build({ food: 5, inventory: [] });
    safety.attach();

    tick(bot, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bot.__calls).not.toContain('consume');
    safety.detach();
  });

  it('does not eat on a full hunger bar', async () => {
    const { bot, safety } = build({ food: 20, inventory: [{ name: 'bread', type: 297, count: 3, slot: 9 }] });
    safety.attach();

    tick(bot, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bot.__calls).not.toContain('consume');
    safety.detach();
  });
});

describe('losing air', () => {
  it('swims up when the head is underwater', () => {
    const { bot, safety } = build({
      oxygenLevel: 3,
      blocks: new Map([[key(0, 65, 0), 'water']]),
    });
    safety.attach();

    tick(bot);
    expect(bot.getControlState('jump')).toBe(true);
    expect(safety.consumeReport().action).toBe('surfaced_for_air');

    bot.oxygenLevel = 18;
    tick(bot);
    expect(bot.getControlState('jump')).toBe(false);
    safety.detach();
  });

  it('does not hold jump when suffocating inside a solid block', () => {
    // Climbing a tree can leave the bot's head inside leaves, which vanilla
    // treats as suffocation. Jumping cannot fix that.
    const { bot, safety } = build({
      oxygenLevel: 4,
      blocks: new Map([[key(0, 65, 0), 'spruce_leaves']]),
    });
    safety.attach();

    tick(bot);
    const report = safety.consumeReport();

    expect(report.action).toBe('suffocating_in_block');
    expect(report.detail).toContain('spruce_leaves');
    expect(bot.getControlState('jump')).toBe(false);
    safety.detach();
  });

  it('ignores an unset oxygen value instead of panicking', () => {
    const { bot, safety } = build();
    (bot as unknown as { oxygenLevel: number | undefined }).oxygenLevel = undefined;
    safety.attach();

    tick(bot, 20);
    expect(safety.consumeReport().action).toBe('none');
    expect(bot.getControlState('jump')).toBe(false);
    safety.detach();
  });

  it('ignores a NaN oxygen value, which `??` would let through', () => {
    const { bot, safety } = build();
    (bot as unknown as { oxygenLevel: number }).oxygenLevel = Number.NaN;
    safety.attach();

    tick(bot, 20);
    expect(safety.consumeReport().action).toBe('none');
    safety.detach();
  });
});

describe('critical-health flight', () => {
  it('flees from nearby hostiles when nearly dead', async () => {
    const { bot, safety } = build(
      {
        health: 3,
        entities: [
          { id: 5, name: 'zombie', type: 'hostile', position: new Vec3(4, 64, 0), height: 1.95, width: 0.6 },
        ],
      },
      { CRITICAL_HEALTH: '4', PANIC_HEALTH: '6' },
    );
    safety.attach();

    tick(bot);
    // The reflex is async, so poll until it has finished and filed its report.
    let report = safety.consumeReport();
    await vi.waitFor(
      () => {
        report = safety.consumeReport();
        if (report.action === 'none') throw new Error('reflex has not reported yet');
      },
      { timeout: 3_000, interval: 25 },
    );

    expect(report.action).toBe('fled_low_health');
    expect(report.detail).toContain('zombie');
    expect(bot.__calls).toContain('pathfinder.goto');
    safety.detach();
  });

  it('just stops moving when the damage is environmental', async () => {
    const { bot, safety } = build({ health: 2 }, { CRITICAL_HEALTH: '4' });
    safety.attach();

    tick(bot);
    let report = safety.consumeReport();
    await vi.waitFor(
      () => {
        report = safety.consumeReport();
        if (report.action === 'none') throw new Error('reflex has not reported yet');
      },
      { timeout: 3_000, interval: 25 },
    );

    expect(report.action).toBe('fled_low_health');
    expect(report.detail).toContain('no hostile nearby');
    expect(bot.__calls).not.toContain('pathfinder.goto');
    safety.detach();
  });
});

describe('opt-out', () => {
  it('does nothing at all when REACTIVE_SAFETY is false', async () => {
    const { bot, safety } = build(
      { health: 1, food: 1, inventory: [{ name: 'bread', type: 297, count: 3, slot: 9 }] },
      { REACTIVE_SAFETY: 'false' },
    );
    safety.attach();

    tick(bot, 30);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bot.__calls).toHaveLength(0);
    expect(safety.consumeReport().action).toBe('none');
  });
});
