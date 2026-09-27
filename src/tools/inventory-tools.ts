import type { ToolResult } from '../types.js';
import { CollectArgs, CraftArgs, EatArgs, EquipArgs, SmeltArgs } from './schemas.js';
import { defineTool, type Tool } from './registry.js';

const equip = defineTool({
  name: 'equip',
  description: EquipArgs.description ?? 'Equip an item.',
  schema: EquipArgs,
  timeoutMs: 8_000,
  execute: async (args, ctx): Promise<ToolResult> =>
    ctx.inventory.equip(args.item, args.destination ?? 'hand'),
});

const eat = defineTool({
  name: 'eat',
  description: EatArgs.description ?? 'Eat food.',
  schema: EatArgs,
  timeoutMs: 12_000,
  execute: async (args, ctx): Promise<ToolResult> => ctx.inventory.eat(args.item),
});

const collect = defineTool({
  name: 'collect',
  description: CollectArgs.description ?? 'Pick up nearby dropped items.',
  schema: CollectArgs,
  timeoutMs: 30_000,
  onTimeout: (ctx) => ctx.movement.stop(),
  execute: async (args, ctx): Promise<ToolResult> =>
    ctx.inventory.collect({
      ...(args.item !== undefined ? { itemName: args.item } : {}),
      radius: args.radius ?? Math.min(12, ctx.cfg.entityRadius),
      maxItems: args.max_items ?? 5,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    }),
});

const craft = defineTool({
  name: 'craft',
  description: CraftArgs.description ?? 'Craft an item.',
  schema: CraftArgs,
  timeoutMs: 25_000,
  onTimeout: (ctx) => ctx.movement.stop(),
  execute: async (args, ctx): Promise<ToolResult> =>
    ctx.crafting.craft(args.item, args.count ?? 1, {
      searchRadius: ctx.cfg.observationRadius,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    }),
});

const smelt = defineTool({
  name: 'smelt',
  description: SmeltArgs.description ?? 'Smelt items in a furnace.',
  schema: SmeltArgs,
  timeoutMs: 30_000,
  onTimeout: (ctx) => ctx.movement.stop(),
  execute: async (args, ctx): Promise<ToolResult> =>
    ctx.crafting.smelt(args.item, args.count ?? 1, {
      searchRadius: ctx.cfg.observationRadius,
      timeoutMs: ctx.timeoutMs,
      ...(args.fuel !== undefined ? { fuelName: args.fuel } : {}),
      signal: ctx.signal,
    }),
});

export const inventoryTools: Tool[] = [
  equip,
  eat,
  collect,
  craft,
  smelt,
];
