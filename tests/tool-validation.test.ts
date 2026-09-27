import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createToolRegistry, defineTool, ToolRegistry, type ToolContext } from '../src/tools/index.js';
import { formatZodIssues, MineArgs, MoveToArgs, toToolJsonSchema, WaitArgs } from '../src/tools/schemas.js';
import { fail, ok } from '../src/types.js';
import { testConfig } from './helpers/fixtures.js';
import { getLogger } from '../src/utils/logger.js';

/** Bare context: validation and timeout tests never reach the game objects. */
function stubContext(overrides: Partial<ToolContext> = {}): Omit<ToolContext, 'timeoutMs'> {
  const cfg = testConfig().agent;
  return {
    bot: {} as ToolContext['bot'],
    registry: {} as ToolContext['registry'],
    observer: {} as ToolContext['observer'],
    movement: { stop: vi.fn() } as unknown as ToolContext['movement'],
    inventory: {} as ToolContext['inventory'],
    combat: {} as ToolContext['combat'],
    blocks: {} as ToolContext['blocks'],
    crafting: {} as ToolContext['crafting'],
    cfg,
    log: getLogger(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('tool argument schemas', () => {
  it('accepts a well-formed move_to', () => {
    expect(MoveToArgs.safeParse({ x: 126, y: 64, z: -30 }).success).toBe(true);
    expect(MoveToArgs.safeParse({ x: 126.5, y: 64, z: -30, range: 2 }).success).toBe(true);
  });

  it('rejects out-of-world and non-finite coordinates', () => {
    expect(MoveToArgs.safeParse({ x: 1e12, y: 64, z: 0 }).success).toBe(false);
    expect(MoveToArgs.safeParse({ x: 0, y: 5_000, z: 0 }).success).toBe(false);
    expect(MoveToArgs.safeParse({ x: Number.NaN, y: 64, z: 0 }).success).toBe(false);
    expect(MoveToArgs.safeParse({ x: Number.POSITIVE_INFINITY, y: 64, z: 0 }).success).toBe(false);
  });

  it('rejects a missing coordinate and a wrong type', () => {
    expect(MoveToArgs.safeParse({ x: 1, y: 2 }).success).toBe(false);
    expect(MoveToArgs.safeParse({ x: '1', y: 2, z: 3 }).success).toBe(false);
  });

  it('rejects an out-of-range arrival tolerance', () => {
    expect(MoveToArgs.safeParse({ x: 1, y: 2, z: 3, range: 100 }).success).toBe(false);
    expect(MoveToArgs.safeParse({ x: 1, y: 2, z: 3, range: -1 }).success).toBe(false);
  });

  it('requires either a block name or a full position for mine', () => {
    expect(MineArgs.safeParse({ block: 'oak_log' }).success).toBe(true);
    expect(MineArgs.safeParse({ x: 1, y: 2, z: 3 }).success).toBe(true);
    expect(MineArgs.safeParse({ count: 3 }).success).toBe(false);
    expect(MineArgs.safeParse({ x: 1, y: 2 }).success).toBe(false);
  });

  it('rejects item names that are not Minecraft identifiers', () => {
    expect(MineArgs.safeParse({ block: 'oak log; rm -rf /' }).success).toBe(false);
    expect(MineArgs.safeParse({ block: '../../etc/passwd' }).success).toBe(false);
    expect(MineArgs.safeParse({ block: 'minecraft:oak_log' }).success).toBe(true);
  });

  it('caps the mine count', () => {
    expect(MineArgs.safeParse({ block: 'stone', count: 16 }).success).toBe(true);
    expect(MineArgs.safeParse({ block: 'stone', count: 999 }).success).toBe(false);
    expect(MineArgs.safeParse({ block: 'stone', count: 1.5 }).success).toBe(false);
  });

  it('bounds the wait duration', () => {
    expect(WaitArgs.safeParse({ seconds: 5 }).success).toBe(true);
    expect(WaitArgs.safeParse({ seconds: 0 }).success).toBe(false);
    expect(WaitArgs.safeParse({ seconds: 3_600 }).success).toBe(false);
  });

  it('formats issues into one readable sentence', () => {
    const parsed = MoveToArgs.safeParse({ x: 'a', y: 2, z: 3 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatZodIssues(parsed.error)).toContain('x');
  });
});

describe('JSON Schema generation', () => {
  it('emits an object schema with no $schema key', () => {
    const schema = toToolJsonSchema(MoveToArgs);
    expect(schema['$schema']).toBeUndefined();
    expect(schema['type']).toBe('object');
    expect(Object.keys(schema['properties'] as object)).toEqual(expect.arrayContaining(['x', 'y', 'z', 'range']));
    expect(schema['required']).toEqual(expect.arrayContaining(['x', 'y', 'z']));
  });

  it('survives schemas carrying a refinement', () => {
    const schema = toToolJsonSchema(MineArgs);
    expect(schema['type']).toBe('object');
    expect(Object.keys(schema['properties'] as object)).toContain('block');
  });

  it('produces every registered tool spec', () => {
    const registry = createToolRegistry();
    const specs = registry.specs();
    expect(specs).toHaveLength(registry.size());
    for (const spec of specs) {
      expect(spec.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(spec.description.length).toBeGreaterThan(10);
      expect(spec.parameters['type']).toBe('object');
    }
  });
});

describe('registered tool set', () => {
  it('contains exactly the required tools', () => {
    const registry = createToolRegistry();
    expect(registry.names()).toEqual(
      [
        'attack',
        'collect',
        'craft',
        'eat',
        'equip',
        'interact',
        'jump',
        'look_at',
        'mine',
        'move_to',
        'observe',
        'pillar_up',
        'place_block',
        'smelt',
        'sneak',
        'sprint',
        'wait',
      ].sort(),
    );
  });

  it('rejects duplicate registration', () => {
    const registry = createToolRegistry();
    expect(() =>
      registry.register(
        defineTool({
          name: 'observe',
          description: 'duplicate',
          schema: z.object({}),
          timeoutMs: 1_000,
          execute: async () => ok({}),
        }),
      ),
    ).toThrow(/already registered/);
  });

  it('describes tools for prompt injection in JSON mode', () => {
    const description = createToolRegistry().describeForPrompt();
    expect(description).toContain('- move_to(');
    expect(description).toContain('· x:');
  });
});

describe('ToolRegistry.execute', () => {
  it('rejects an unknown tool with the available list', async () => {
    const registry = createToolRegistry();
    const result = await registry.execute('teleport_to_moon', {}, stubContext());
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('UNKNOWN_TOOL');
    expect(result.details).toContain('move_to');
  });

  it('rejects invalid arguments before touching the game', async () => {
    const registry = createToolRegistry();
    const result = await registry.execute('move_to', { x: 'over there' }, stubContext());
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('INVALID_ARGUMENTS');
    expect(result.details).toContain('move_to');
  });

  it('treats null arguments as an empty object', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'noop',
        description: 'does nothing at all',
        schema: z.object({ flag: z.boolean().default(false) }),
        timeoutMs: 1_000,
        execute: async (args) => ok(args),
      }),
    );
    const result = await registry.execute('noop', null, stubContext());
    expect(result).toMatchObject({ success: true, data: { flag: false } });
  });

  it('enforces the per-tool timeout and runs onTimeout cleanup', async () => {
    const registry = new ToolRegistry();
    const cleanup = vi.fn();
    registry.register(
      defineTool({
        name: 'hangs',
        description: 'never resolves, to test the deadline',
        schema: z.object({}),
        timeoutMs: 120,
        onTimeout: cleanup,
        execute: () => new Promise(() => undefined),
      }),
    );

    const result = await registry.execute('hangs', {}, stubContext());
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('TIMEOUT');
    expect(result.details).toContain('120ms');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('clamps a tool timeout to the global maximum', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'greedy',
        description: 'asks for far more time than the config allows',
        schema: z.object({}),
        timeoutMs: 600_000,
        execute: () => new Promise(() => undefined),
      }),
    );

    const cfg = testConfig({ MAX_ACTION_TIMEOUT_MS: '1000' }).agent;
    const result = await registry.execute('greedy', {}, stubContext({ cfg }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.details).toContain('1000ms');
  });

  it('turns a thrown error into a structured failure', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'explodes',
        description: 'throws synchronously inside the tool body',
        schema: z.object({}),
        timeoutMs: 1_000,
        execute: async () => {
          throw new Error('mineflayer blew up');
        },
      }),
    );

    const result = await registry.execute('explodes', {}, stubContext());
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('MINEFLAYER_ERROR');
    expect(result.details).toContain('mineflayer blew up');
  });

  it('refuses to start when the safety signal is already aborted', async () => {
    const registry = createToolRegistry();
    const controller = new AbortController();
    controller.abort();
    const result = await registry.execute('observe', {}, stubContext({ signal: controller.signal }));
    expect(result).toMatchObject({ success: false, error: 'ABORTED' });
  });

  it('preserves a failure produced inside the tool', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'polite_failure',
        description: 'returns a structured failure of its own',
        schema: z.object({}),
        timeoutMs: 1_000,
        execute: async () => fail('NO_FUEL', 'out of coal'),
      }),
    );
    const result = await registry.execute('polite_failure', {}, stubContext());
    expect(result).toMatchObject({ success: false, error: 'NO_FUEL', details: 'out of coal' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
