import { z } from 'zod';
import { EQUIPMENT_DESTINATIONS } from '../minecraft/inventory.js';

/* ───────────────────────── primitive building blocks ──────────────────── */

/** Horizontal coordinate, bounded by Minecraft's world border. */
const HorizontalCoord = z
  .number()
  .finite()
  .min(-30_000_000)
  .max(30_000_000);

/** Vertical coordinate, generous enough for every dimension's build limits. */
const VerticalCoord = z.number().finite().min(-512).max(1_024);

const ItemName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // Rejects anything that is not a plausible Minecraft identifier before it
  // reaches the registry, so prompt-injected junk never becomes a lookup.
  .regex(/^(minecraft:)?[a-z0-9_]+$/i, 'must be a Minecraft identifier such as "iron_ingot"');

const BlockName = ItemName;

const EntityId = z.number().int().min(0).max(2_147_483_647);

/* ──────────────────────────── tool arguments ──────────────────────────── */

export const ObserveArgs = z
  .object({
    /**
     * Free-text hint recorded with the observation. Purely informational — the
     * observer always returns the full compact state.
     */
    focus: z.string().trim().max(120).optional().describe('Optional note about what you are looking for.'),
  })
  .describe('Re-read the world state without acting. Use after a failure, or when the state looks stale.');

export const MoveToArgs = z
  .object({
    x: HorizontalCoord.describe('Target X coordinate.'),
    y: VerticalCoord.describe('Target Y coordinate (height).'),
    z: HorizontalCoord.describe('Target Z coordinate.'),
    range: z
      .number()
      .min(0)
      .max(16)
      .optional()
      .describe('How close counts as arrived, in blocks. Default 1.'),
  })
  .describe(
    'Walk to a position using the pathfinder. It handles jumping, doors, digging through obstacles and parkour. ' +
      'Must be within the per-move distance limit — take several hops for longer journeys.',
  );

export const LookAtArgs = z
  .object({
    x: HorizontalCoord.optional().describe('X of the point to look at.'),
    y: VerticalCoord.optional().describe('Y of the point to look at.'),
    z: HorizontalCoord.optional().describe('Z of the point to look at.'),
    entity_id: EntityId.optional().describe('Look at this entity instead of a point.'),
    yaw: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2).optional().describe('Absolute yaw in radians.'),
    pitch: z.number().finite().min(-Math.PI).max(Math.PI).optional().describe('Absolute pitch in radians.'),
  })
  .describe('Turn to face a point, an entity, or an absolute yaw/pitch.')
  .refine(
    (args) =>
      (args.x !== undefined && args.y !== undefined && args.z !== undefined) ||
      args.entity_id !== undefined ||
      args.yaw !== undefined ||
      args.pitch !== undefined,
    { message: 'Provide x/y/z, or entity_id, or yaw/pitch.' },
  );

export const MineArgs = z
  .object({
    block: BlockName.optional().describe('Block type to mine, e.g. "oak_log". Required when no position is given.'),
    x: HorizontalCoord.optional().describe('X of a specific block to mine.'),
    y: VerticalCoord.optional().describe('Y of a specific block to mine.'),
    z: HorizontalCoord.optional().describe('Z of a specific block to mine.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe('Mine up to this many blocks of the same type. Default 1.'),
    collect: z.boolean().optional().describe('Walk onto the drops afterwards. Default true.'),
  })
  .describe(
    'Break a block and pick up what it drops. The best available tool is equipped automatically. ' +
      'Give a block name to mine the nearest one, or exact coordinates to mine a specific block.',
  )
  .refine(
    (args) =>
      args.block !== undefined ||
      (args.x !== undefined && args.y !== undefined && args.z !== undefined),
    { message: 'Provide a block name, or all of x/y/z, or both.' },
  );

export const PlaceBlockArgs = z
  .object({
    item: ItemName.describe('Block item to place from the inventory, e.g. "crafting_table".'),
    x: HorizontalCoord.describe('X where the block should end up.'),
    y: VerticalCoord.describe('Y where the block should end up.'),
    z: HorizontalCoord.describe('Z where the block should end up.'),
  })
  .describe(
    'Place a block from the inventory at a position. The position must be empty and have a solid neighbour to attach to.',
  );

export const AttackArgs = z
  .object({
    entity: ItemName.optional().describe('Entity type or player name to attack, e.g. "zombie".'),
    entity_id: EntityId.optional().describe('Exact entity id from the observed state (preferred).'),
    max_swings: z
      .number()
      .int()
      .min(1)
      .max(40)
      .optional()
      .describe('Stop after this many hits. Default 12.'),
  })
  .describe('Melee-attack an entity, closing the distance first and equipping the best weapon.')
  .refine((args) => args.entity !== undefined || args.entity_id !== undefined, {
    message: 'Provide entity or entity_id.',
  });

export const EquipArgs = z
  .object({
    item: ItemName.describe('Item to equip, e.g. "stone_pickaxe".'),
    destination: z
      .enum(EQUIPMENT_DESTINATIONS)
      .optional()
      .describe('Where to equip it. Default "hand".'),
  })
  .describe('Equip an item from the inventory into the hand or an armour slot.');

export const EatArgs = z
  .object({
    item: ItemName.optional().describe('Specific food to eat. Omit to let the agent choose the best option.'),
  })
  .describe('Eat food to restore the hunger bar. Fails if the hunger bar is already full.');

export const CraftArgs = z
  .object({
    item: ItemName.describe('Item to craft, e.g. "wooden_pickaxe".'),
    count: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe('How many to end up with. Default 1.'),
  })
  .describe(
    'Craft an item. A nearby crafting table is used automatically when the recipe needs one; ' +
      'missing ingredients are reported explicitly.',
  );

export const SmeltArgs = z
  .object({
    item: ItemName.describe('Item to smelt, e.g. "raw_iron".'),
    count: z.number().int().min(1).max(32).optional().describe('How many to smelt. Default 1.'),
    fuel: ItemName.optional().describe('Fuel to use. Omit to pick the cheapest suitable fuel.'),
  })
  .describe('Smelt items in a nearby furnace, blast furnace or smoker. Roughly 10 seconds per item.');

export const CollectArgs = z
  .object({
    item: ItemName.optional().describe('Only pick up this item type. Omit to collect anything nearby.'),
    radius: z.number().min(1).max(32).optional().describe('Search radius in blocks. Default 12.'),
    max_items: z.number().int().min(1).max(10).optional().describe('Maximum stacks to collect. Default 5.'),
  })
  .describe('Walk to nearby dropped item stacks and pick them up.');

export const InteractArgs = z
  .object({
    block: BlockName.optional().describe('Block type to interact with, e.g. "oak_door".'),
    x: HorizontalCoord.optional().describe('X of a specific block.'),
    y: VerticalCoord.optional().describe('Y of a specific block.'),
    z: HorizontalCoord.optional().describe('Z of a specific block.'),
  })
  .describe('Right-click a block: open a door, flip a lever, press a button, use a bed, and so on.')
  .refine(
    (args) =>
      args.block !== undefined ||
      (args.x !== undefined && args.y !== undefined && args.z !== undefined),
    { message: 'Provide a block name, or all of x/y/z.' },
  );

export const JumpArgs = z
  .object({
    count: z.number().int().min(1).max(5).optional().describe('How many times to jump. Default 1.'),
  })
  .describe('Jump in place. Useful for clearing a one-block step or escaping a shallow hole.');

export const PillarUpArgs = z
  .object({
    height: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe('How many blocks to build upward. Default 2.'),
    item: ItemName.optional().describe(
      'Block to build with. Omit to let the agent pick the most expendable one.',
    ),
  })
  .describe(
    'Build a pillar straight up by placing a block under your own feet, one per jump. ' +
      'This is how you get out of a hole you dug, or out of a ravine or cave you fell into.',
  );

export const SneakArgs = z
  .object({
    enabled: z.boolean().describe('True to start sneaking, false to stop.'),
  })
  .describe('Toggle sneaking, which prevents falling off edges.');

export const SprintArgs = z
  .object({
    enabled: z.boolean().describe('True to start sprinting, false to stop.'),
  })
  .describe('Toggle sprinting. Costs hunger but moves faster.');

export const WaitArgs = z
  .object({
    seconds: z
      .number()
      .min(0.1)
      .max(20)
      .describe('How long to wait, in seconds.'),
    reason: z.string().trim().max(120).optional().describe('Why waiting is useful right now.'),
  })
  .describe('Do nothing for a while — waiting out rain, letting a furnace finish, or letting mobs wander off.');

/* ────────────────────────── JSON Schema emission ──────────────────────── */

/**
 * Converts a Zod schema into the JSON Schema shape OpenRouter expects for
 * native tool calling. `$schema` is stripped because some providers reject it.
 */
export function toToolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    // A refinement cannot be expressed in JSON Schema; the Zod check still runs
    // at execution time, so it is safe to omit from the advertised schema.
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  delete generated['$schema'];
  // Providers require an object schema even when a tool takes no arguments.
  if (generated['type'] === undefined) generated['type'] = 'object';
  if (generated['properties'] === undefined) generated['properties'] = {};
  return generated;
}

/** Formats Zod issues into a single actionable sentence for the model. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'arguments';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
