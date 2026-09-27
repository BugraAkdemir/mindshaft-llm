import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

// `Movements` reads deeply from the real registry, so it is stubbed; the goal
// classes are replaced with inert markers we can assert on.
vi.mock('mineflayer-pathfinder', async () => {
  const mock = await import('./helpers/pathfinder-mock.js');
  return mock.pathfinderMockModule();
});

const { MovementController } = await import('../src/minecraft/movement.js');
const { asBot, createMockBot } = await import('./helpers/mock-bot.js');
const { testConfig } = await import('./helpers/fixtures.js');

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function setup(envOverrides: Record<string, string> = {}) {
  const bot = createMockBot({ position: new Vec3(0.5, 64, 0.5) });
  const cfg = testConfig(envOverrides).agent;
  return { bot, cfg, movement: new MovementController(asBot(bot), cfg) };
}

describe('movement limits', () => {
  it('rejects a target beyond MAX_MOVE_DISTANCE without pathing', async () => {
    const { bot, movement } = setup({ MAX_MOVE_DISTANCE: '64' });
    const result = await movement.moveTo({ x: 500, y: 64, z: 0 }, { timeoutMs: 5_000 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('TARGET_TOO_FAR');
    expect(result.details).toContain('64-block');
    expect(bot.__calls).not.toContain('pathfinder.goto');
  });

  it('honours a lowered MAX_MOVE_DISTANCE', async () => {
    const { movement } = setup({ MAX_MOVE_DISTANCE: '8' });
    const result = await movement.moveTo({ x: 20, y: 64, z: 0 }, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ success: false, error: 'TARGET_TOO_FAR' });
  });

  it('accepts a target at exactly the limit', async () => {
    const { movement } = setup({ MAX_MOVE_DISTANCE: '64' });
    const result = await movement.moveTo({ x: 64.5, y: 64, z: 0.5 }, { timeoutMs: 5_000 });
    expect(result.success).toBe(true);
  });

  it('rejects coordinates outside the world bounds as UNSAFE', async () => {
    const { movement } = setup();
    const result = await movement.moveTo({ x: Number.NaN, y: 64, z: 0 }, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ success: false, error: 'UNSAFE' });
  });

  it('short-circuits when already inside the arrival tolerance', async () => {
    const { bot, movement } = setup();
    const result = await movement.moveTo({ x: 1, y: 64, z: 1 }, { timeoutMs: 5_000, range: 3 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.travelled).toBe(0);
    expect(bot.__calls).not.toContain('pathfinder.goto');
  });
});

describe('movement failure mapping', () => {
  let bot: ReturnType<typeof createMockBot>;
  let movement: InstanceType<typeof MovementController>;

  beforeEach(() => {
    const created = setup();
    bot = created.bot;
    movement = created.movement;
  });

  it('maps NoPath to PATH_NOT_FOUND with actionable detail', async () => {
    bot.pathfinder.goto = async () => {
      throw named('NoPath');
    };
    const result = await movement.moveTo({ x: 10, y: 64, z: 10 }, { timeoutMs: 5_000 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('PATH_NOT_FOUND');
    expect(result.details).toContain('No reachable path');
    expect(result.details).toContain('waypoint');
  });

  it('maps a pathfinder Timeout to PATH_TIMEOUT', async () => {
    bot.pathfinder.goto = async () => {
      throw named('Timeout');
    };
    const result = await movement.moveTo({ x: 10, y: 64, z: 10 }, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ success: false, error: 'PATH_TIMEOUT' });
  });

  it('maps GoalChanged and PathStopped to PATH_INTERRUPTED', async () => {
    bot.pathfinder.goto = async () => {
      throw named('GoalChanged');
    };
    expect(await movement.moveTo({ x: 10, y: 64, z: 10 }, { timeoutMs: 5_000 })).toMatchObject({
      success: false,
      error: 'PATH_INTERRUPTED',
    });

    bot.pathfinder.goto = async () => {
      throw named('PathStopped');
    };
    expect(await movement.moveTo({ x: 10, y: 64, z: 10 }, { timeoutMs: 5_000 })).toMatchObject({
      success: false,
      error: 'PATH_INTERRUPTED',
    });
  });

  it('maps an unrecognised error to MINEFLAYER_ERROR', async () => {
    bot.pathfinder.goto = async () => {
      throw new Error('socket exploded');
    };
    const result = await movement.moveTo({ x: 10, y: 64, z: 10 }, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ success: false, error: 'MINEFLAYER_ERROR' });
    if (result.success) return;
    expect(result.details).toContain('socket exploded');
  });

  it('enforces its own movement timeout and stops the pathfinder', async () => {
    bot.pathfinder.goto = () => new Promise(() => undefined);
    const result = await movement.moveTo({ x: 10, y: 64, z: 10 }, { timeoutMs: 400 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('PATH_TIMEOUT');
    expect(result.details).toContain('400ms');
    expect(bot.__calls).toContain('pathfinder.stop');
  });

  it('reports ABORTED when the safety layer cancels mid-path', async () => {
    bot.pathfinder.goto = () => new Promise(() => undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const result = await movement.moveTo(
      { x: 10, y: 64, z: 10 },
      { timeoutMs: 10_000, signal: controller.signal },
    );
    expect(result).toMatchObject({ success: false, error: 'ABORTED' });
  });

  it('reports ABORTED immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    bot.pathfinder.goto = () => new Promise(() => undefined);

    const result = await movement.moveTo(
      { x: 10, y: 64, z: 10 },
      { timeoutMs: 10_000, signal: controller.signal },
    );
    expect(result).toMatchObject({ success: false, error: 'ABORTED' });
  });
});

describe('stuck detection', () => {
  it('gives up when the bot stops making progress', async () => {
    const { bot, movement } = setup();
    // Never resolves and the bot never moves: exactly the "wedged on terrain" case.
    bot.pathfinder.goto = () => new Promise(() => undefined);

    const result = await movement.moveTo({ x: 20, y: 64, z: 0 }, { timeoutMs: 15_000 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('PATH_INTERRUPTED');
    expect(result.details).toContain('Stuck');
  }, 15_000);

  it('does not report stuck while the pathfinder is mining through an obstacle', async () => {
    const { bot, movement } = setup();
    bot.pathfinder.isMining = () => true;
    let resolvePath: () => void = () => undefined;
    bot.pathfinder.goto = () => new Promise<void>((resolve) => {
      resolvePath = resolve;
    });

    const pending = movement.moveTo({ x: 20, y: 64, z: 0 }, { timeoutMs: 14_000 });
    // Longer than the stuck threshold; mining must suppress the detector.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    resolvePath();

    const result = await pending;
    expect(result.success).toBe(true);
  }, 15_000);
});

describe('movement plumbing', () => {
  it('builds Movements once and rebuilds after invalidation', () => {
    const { movement } = setup();
    const first = movement.getMovements();
    expect(movement.getMovements()).toBe(first);

    movement.invalidateMovements();
    expect(movement.getMovements()).not.toBe(first);
  });

  it('configures the pathfinder conservatively around hazards', () => {
    const { movement } = setup();
    const movements = movement.getMovements();
    expect(movements.dontCreateFlow).toBe(true);
    expect(movements.dontMineUnderFallingBlock).toBe(true);
  });

  it('stop() clears control states and is safe when idle', () => {
    const { bot, movement } = setup();
    bot.setControlState('forward', true);
    movement.stop();
    expect(bot.getControlState('forward')).toBe(false);
    expect(() => movement.stop()).not.toThrow();
  });

  it('moveToBlock skips pathing when the block centre is already in reach', async () => {
    const { bot, movement } = setup();
    // Bot is at (0.5, 64, 0.5); the centre of block (2,64,0) is ~2.1 blocks away.
    const result = await movement.moveToBlock({ x: 2, y: 64, z: 0 }, { timeoutMs: 5_000, reach: 3 });
    expect(result.success).toBe(true);
    expect(bot.__calls).not.toContain('pathfinder.goto');
  });

  it('moveToBlock paths when the block is out of reach', async () => {
    const { bot, movement } = setup();
    const result = await movement.moveToBlock({ x: 10, y: 64, z: 0 }, { timeoutMs: 5_000, reach: 3 });
    expect(result.success).toBe(true);
    expect(bot.__calls).toContain('pathfinder.goto');
  });
});
