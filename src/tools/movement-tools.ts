import { ok, fail, type ToolResult } from '../types.js';
import {
  JumpArgs,
  LookAtArgs,
  MoveToArgs,
  PillarUpArgs,
  SneakArgs,
  SprintArgs,
  WaitArgs,
} from './schemas.js';
import { defineTool, type Tool } from './registry.js';

const moveTo = defineTool({
  name: 'move_to',
  description: MoveToArgs.description ?? 'Walk to a position.',
  schema: MoveToArgs,
  timeoutMs: 30_000,
  onTimeout: (ctx) => ctx.movement.stop(),
  execute: async (args, ctx) => {
    const options = {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      ...(args.range !== undefined ? { range: args.range } : {}),
    };
    return ctx.movement.moveTo({ x: args.x, y: args.y, z: args.z }, options);
  },
});

const lookAt = defineTool({
  name: 'look_at',
  description: LookAtArgs.description ?? 'Turn to face something.',
  schema: LookAtArgs,
  timeoutMs: 5_000,
  execute: async (args, ctx) => {
    const target: { position?: { x: number; y: number; z: number }; entityId?: number; yaw?: number; pitch?: number } = {};
    if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
      target.position = { x: args.x, y: args.y, z: args.z };
    }
    if (args.entity_id !== undefined) target.entityId = args.entity_id;
    if (args.yaw !== undefined) target.yaw = args.yaw;
    if (args.pitch !== undefined) target.pitch = args.pitch;
    return ctx.blocks.lookAt(target);
  },
});

const jump = defineTool({
  name: 'jump',
  description: JumpArgs.description ?? 'Jump in place.',
  schema: JumpArgs,
  timeoutMs: 6_000,
  onTimeout: (ctx) => ctx.bot.setControlState('jump', false),
  execute: async (args, ctx) => {
    const count = args.count ?? 1;
    for (let i = 0; i < count; i += 1) {
      if (ctx.signal.aborted) break;
      ctx.bot.setControlState('jump', true);
      await ctx.bot.waitForTicks(2);
      ctx.bot.setControlState('jump', false);
      // Land before jumping again, otherwise the second jump is swallowed.
      if (i < count - 1) await ctx.bot.waitForTicks(8);
    }
    return ok({ jumps: count, onGround: ctx.bot.entity.onGround });
  },
});

const pillarUp = defineTool({
  name: 'pillar_up',
  description: PillarUpArgs.description ?? 'Build a pillar upward to escape a hole.',
  schema: PillarUpArgs,
  timeoutMs: 20_000,
  onTimeout: (ctx) => {
    ctx.bot.setControlState('jump', false);
    ctx.movement.stop();
  },
  execute: async (args, ctx) =>
    ctx.blocks.pillarUp(args.height ?? 2, {
      ...(args.item !== undefined ? { itemName: args.item } : {}),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    }),
});

const sneak = defineTool({
  name: 'sneak',
  description: SneakArgs.description ?? 'Toggle sneaking.',
  schema: SneakArgs,
  timeoutMs: 3_000,
  execute: async (args, ctx) => {
    ctx.bot.setControlState('sneak', args.enabled);
    return ok({ sneaking: args.enabled });
  },
});

const sprint = defineTool({
  name: 'sprint',
  description: SprintArgs.description ?? 'Toggle sprinting.',
  schema: SprintArgs,
  timeoutMs: 3_000,
  execute: async (args, ctx) => {
    if (args.enabled && ctx.bot.food <= 6) {
      return fail('UNSAFE', 'Cannot sprint with a hunger level of 6 or less — eat first.');
    }
    ctx.bot.setControlState('sprint', args.enabled);
    return ok({ sprinting: args.enabled });
  },
});

const wait = defineTool({
  name: 'wait',
  description: WaitArgs.description ?? 'Do nothing for a while.',
  schema: WaitArgs,
  timeoutMs: 25_000,
  execute: async (args, ctx) => {
    const requestedMs = Math.round(args.seconds * 1_000);
    // Never wait past the tool's own budget.
    const waitMs = Math.min(requestedMs, ctx.timeoutMs - 500);
    const startedAt = Date.now();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, Math.max(0, waitMs));
      const onAbort = (): void => finish();
      function finish(): void {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve();
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });

    const actualMs = Date.now() - startedAt;
    if (ctx.signal.aborted) {
      return fail('ABORTED', `Wait was interrupted after ${(actualMs / 1_000).toFixed(1)}s by the safety layer.`);
    }
    return ok({
      waitedSeconds: Number((actualMs / 1_000).toFixed(1)),
      ...(args.reason ? { reason: args.reason } : {}),
    });
  },
});

export const movementTools: Tool[] = [
  moveTo,
  lookAt,
  jump,
  pillarUp,
  sneak,
  sprint,
  wait,
];

export type { ToolResult };
