import { fail, type ToolResult } from '../types.js';
import { AttackArgs } from './schemas.js';
import { defineTool, type Tool } from './registry.js';

const attack = defineTool({
  name: 'attack',
  description: AttackArgs.description ?? 'Attack an entity.',
  schema: AttackArgs,
  timeoutMs: 30_000,
  onTimeout: (ctx) => ctx.movement.stop(),
  execute: async (args, ctx): Promise<ToolResult> => {
    const ref: { entityId?: number; entityName?: string } = {};
    if (args.entity_id !== undefined) ref.entityId = args.entity_id;
    if (args.entity !== undefined) ref.entityName = args.entity;

    const target = ctx.combat.resolveTarget(ref, ctx.cfg.entityRadius);
    if (!target) {
      const hostiles = ctx.combat
        .hostilesWithin(ctx.cfg.entityRadius)
        .slice(0, 5)
        .map((entity) => `${entity.name ?? 'hostile'} (id ${entity.id})`);
      return fail(
        'ENTITY_NOT_FOUND',
        `${args.entity_id !== undefined ? `Entity id ${args.entity_id}` : `"${args.entity}"`} is not within ${ctx.cfg.entityRadius} blocks. ` +
          (hostiles.length ? `Nearby hostiles: ${hostiles.join(', ')}.` : 'No hostiles nearby.'),
      );
    }

    // Refuse to attack players: that is griefing, and never what the goal needs.
    if (target.type === 'player') {
      return fail(
        'UNSAFE',
        `Refusing to attack the player "${target.username ?? target.name}". Only mobs may be attacked.`,
      );
    }

    return ctx.combat.attack(target, {
      timeoutMs: ctx.timeoutMs,
      maxSwings: args.max_swings ?? 12,
      signal: ctx.signal,
    });
  },
});

export const combatTools: Tool[] = [attack];
