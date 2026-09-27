import { fail, ok, type ToolResult } from '../types.js';
import { InteractArgs, MineArgs, ObserveArgs, PlaceBlockArgs } from './schemas.js';
import { defineTool, type Tool } from './registry.js';

/**
 * Margin reserved before the tool's hard deadline so a multi-block `mine` can
 * return what it already gathered instead of being cancelled outright.
 */
const PARTIAL_RESULT_HEADROOM_MS = 2_500;

const observe = defineTool({
  name: 'observe',
  description: ObserveArgs.description ?? 'Re-read the world state.',
  schema: ObserveArgs,
  timeoutMs: 5_000,
  execute: async (args, ctx) => {
    const state = ctx.observer.observe();
    return ok({
      // A compact digest; the full state is injected into the next prompt anyway,
      // so repeating all of it here would double the context cost.
      position: state.player.position,
      health: state.player.health,
      food: state.player.food,
      blockTypesNearby: state.nearbyBlocks.length,
      entitiesNearby: state.entities.length,
      threats: state.threats.map((threat) => `${threat.name} ${threat.distance}m ${threat.direction}`),
      topBlocks: state.nearbyBlocks.slice(0, 6).map((group) => `${group.type} x${group.count} @${group.distance}m`),
      ...(args.focus ? { focus: args.focus } : {}),
    });
  },
});

const mine = defineTool({
  name: 'mine',
  description: MineArgs.description ?? 'Break a block.',
  schema: MineArgs,
  timeoutMs: 30_000,
  onTimeout: (ctx) => {
    ctx.bot.stopDigging();
    ctx.movement.stop();
  },
  execute: async (args, ctx) => {
    const count = args.count ?? 1;
    const collect = args.collect ?? true;
    const hasPosition = args.x !== undefined && args.y !== undefined && args.z !== undefined;

    // An explicit position only identifies one block, so a count above 1 only
    // makes sense for name-based mining.
    const iterations = hasPosition ? 1 : count;
    // Finish before the registry's own deadline, otherwise the executor cancels
    // this loop and the blocks already mined are reported as a total failure.
    const deadline = Date.now() + Math.max(2_000, ctx.timeoutMs - PARTIAL_RESULT_HEADROOM_MS);
    const mined: Array<{ block: string; position: unknown; drops: unknown }> = [];
    let lastFailure: ToolResult | null = null;

    for (let i = 0; i < iterations; i += 1) {
      if (ctx.signal.aborted) break;
      const remainingMs = deadline - Date.now();
      // Digging a single block needs headroom for walking there as well.
      if (remainingMs < 2_000) break;

      const target: { blockName?: string; position?: { x: number; y: number; z: number } } = {};
      if (args.block !== undefined) target.blockName = args.block;
      if (hasPosition) target.position = { x: args.x!, y: args.y!, z: args.z! };

      const result = await ctx.blocks.mine(target, {
        searchRadius: ctx.cfg.observationRadius,
        timeoutMs: remainingMs,
        collectDrops: collect,
        signal: ctx.signal,
      });

      if (!result.success) {
        lastFailure = result;
        break;
      }
      mined.push({ block: result.data.block, position: result.data.position, drops: result.data.drops });
    }

    const ranOutOfTime = mined.length < iterations && lastFailure === null && !ctx.signal.aborted;

    if (mined.length === 0) {
      if (ranOutOfTime) {
        return fail(
          'TIMEOUT',
          `Ran out of time before any ${args.block ?? 'block'} could be mined. ` +
            'Move closer first, or mine one block at a time.',
        );
      }
      return lastFailure ?? ok({ mined: [], note: 'Nothing was mined.' });
    }

    return ok({
      mined,
      minedCount: mined.length,
      requested: iterations,
      ...(lastFailure && !lastFailure.success
        ? { stoppedEarly: `${lastFailure.error}: ${lastFailure.details}` }
        : {}),
      ...(ranOutOfTime
        ? { stoppedEarly: `TIMEOUT: mined ${mined.length} of ${iterations} before running out of time. Call mine again to continue.` }
        : {}),
      inventory: ctx.inventory.summarize(),
    });
  },
});

const placeBlock = defineTool({
  name: 'place_block',
  description: PlaceBlockArgs.description ?? 'Place a block.',
  schema: PlaceBlockArgs,
  timeoutMs: 20_000,
  onTimeout: (ctx) => ctx.movement.stop(),
  execute: async (args, ctx) =>
    ctx.blocks.place(
      args.item,
      { x: args.x, y: args.y, z: args.z },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    ),
});

const interact = defineTool({
  name: 'interact',
  description: InteractArgs.description ?? 'Right-click a block.',
  schema: InteractArgs,
  timeoutMs: 20_000,
  onTimeout: (ctx) => ctx.movement.stop(),
  execute: async (args, ctx) => {
    const target: { blockName?: string; position?: { x: number; y: number; z: number } } = {};
    if (args.block !== undefined) target.blockName = args.block;
    if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
      target.position = { x: args.x, y: args.y, z: args.z };
    }
    return ctx.blocks.interact(target, {
      searchRadius: ctx.cfg.observationRadius,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
  },
});

export const worldTools: Tool[] = [
  observe,
  mine,
  placeBlock,
  interact,
];
