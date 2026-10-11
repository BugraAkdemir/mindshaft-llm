import { describe, expect, it } from 'vitest';
import { buildArguments, supportsArgs } from '../src/llm/jev-args.js';
import {
  AttackArgs,
  CollectArgs,
  CraftArgs,
  EatArgs,
  EquipArgs,
  InteractArgs,
  JumpArgs,
  LookAtArgs,
  MineArgs,
  MoveToArgs,
  ObserveArgs,
  PillarUpArgs,
  PlaceBlockArgs,
  SayArgs,
  SneakArgs,
  SmeltArgs,
  SprintArgs,
  WaitArgs,
} from '../src/tools/schemas.js';
import type { JevAnswers } from '../src/llm/jev-format.js';
import type { WorldState } from '../src/types.js';

const observation = {
  player: { position: { x: 10, y: 64, z: 20 }, health: 12, food: 18 },
  environment: { timeOfDay: 'dusk', isDay: false, stuckInPit: true },
  nearbyBlocks: [
    {
      type: 'oak_log',
      count: 12,
      nearest: { x: 11, y: 64, z: 18 },
      distance: 3,
      direction: 'north',
      relative: { x: 1, y: 0, z: -2 },
    },
  ],
  entities: [
    {
      id: 42,
      type: 'zombie',
      name: 'Zombie',
      category: 'hostile',
      position: { x: 12, y: 64, z: 20 },
      distance: 2,
      direction: 'east',
      relative: { x: 2, y: 0, z: 0 },
      health: 20,
    },
  ],
  threats: [
    {
      id: 42,
      type: 'zombie',
      name: 'Zombie',
      category: 'hostile',
      position: { x: 12, y: 64, z: 20 },
      distance: 2,
      direction: 'east',
      relative: { x: 2, y: 0, z: 0 },
      health: 20,
    },
  ],
  inventory: [],
  inventoryCounts: { oak_log: 4, cobblestone: 9, stick: 3, bread: 2, stone_pickaxe: 1 },
} as unknown as WorldState;

const base: JevAnswers = {
  tool: 'mine',
  toolProbabilities: { mine: 1 },
  toolConfidence: 1,
  target: 'oak_log',
  urgency: 'calm',
  goalComplete: false,
  rememberWorth: false,
};

const pick = (over: Partial<JevAnswers>): JevAnswers => ({ ...base, ...over });
const argsFor = (over: Partial<JevAnswers>) => buildArguments(pick(over), observation);

describe('mine', () => {
  it('fills the block and count, and passes the real schema', () => {
    const args = argsFor({ tool: 'mine' });
    expect(MineArgs.safeParse(args).success).toBe(true);
    expect(args['block']).toBe('oak_log');
    expect(args['collect']).toBe(true);
  });

  it('scales the count with urgency', () => {
    expect(argsFor({ urgency: 'critical' })['count']).toBe(6);
    expect(argsFor({ urgency: 'calm' })['count']).toBe(3);
  });

  it('never invents a target it was not given', () => {
    const args = argsFor({ tool: 'mine', target: undefined });
    expect(args['block']).toBeUndefined();
    expect(MineArgs.safeParse(args).success).toBe(false);
  });
});

describe('move_to', () => {
  it('walks to the nearest instance of the target', () => {
    const args = argsFor({ tool: 'move_to' });
    expect(args).toMatchObject({ x: 11, y: 64, z: 18 });
    expect(MoveToArgs.safeParse(args).success).toBe(true);
  });

  it('returns nothing usable when there is no target', () => {
    expect(argsFor({ tool: 'move_to', target: undefined })).toEqual({});
  });
});

describe('combat', () => {
  it('attacks the nearest hostile entity by id', () => {
    const args = argsFor({ tool: 'attack' });
    expect(args['entity_id']).toBe(42);
    expect(AttackArgs.safeParse(args).success).toBe(true);
  });

  it('swing harder when urgent', () => {
    expect(argsFor({ tool: 'attack', urgency: 'critical' })['max_swings']).toBe(24);
  });

  it('does nothing when no hostile entity is around', () => {
    const empty = { ...observation, entities: [], threats: [] } as unknown as WorldState;
    expect(buildArguments(pick({ tool: 'attack' }), empty)).toEqual({});
  });
});

describe('inventory tools', () => {
  it('crafts whatever the ladder says is next', () => {
    const args = argsFor({ tool: 'craft' });
    expect(CraftArgs.safeParse(args).success).toBe(true);
    // Unconverted logs still have to become planks before anything else.
    expect(args['item']).toBe('oak_planks');
  });

  it('crafts nothing from an empty inventory', () => {
    const empty = { ...observation, inventoryCounts: {} } as unknown as WorldState;
    expect(buildArguments(pick({ tool: 'craft' }), empty)).toEqual({});
  });

  it('equips the best pickaxe it owns', () => {
    const args = argsFor({ tool: 'equip' });
    expect(args['item']).toBe('stone_pickaxe');
    expect(EquipArgs.safeParse(args).success).toBe(true);
  });

  it('eats food it owns', () => {
    const args = argsFor({ tool: 'eat' });
    expect(args['item']).toBe('bread');
    expect(EatArgs.safeParse(args).success).toBe(true);
  });

  it('collects with a default radius', () => {
    const args = argsFor({ tool: 'collect' });
    expect(CollectArgs.safeParse(args).success).toBe(true);
    expect(args['radius']).toBe(12);
  });
});

describe('smelt', () => {
  it('needs a furnace actually nearby', () => {
    expect(argsFor({ tool: 'smelt' })).toEqual({});
  });

  it('smelts raw ore once a furnace is placed', () => {
    const withFurnace = {
      ...observation,
      nearbyBlocks: [
        ...observation.nearbyBlocks,
        { type: 'furnace', count: 1, nearest: { x: 11, y: 64, z: 19 }, distance: 2, direction: 'north', relative: { x: 1, y: 0, z: -1 } },
      ],
      inventoryCounts: { ...observation.inventoryCounts, raw_iron: 3 },
    } as unknown as WorldState;
    const args = buildArguments(pick({ tool: 'smelt' }), withFurnace);
    expect(args['item']).toBe('raw_iron');
    expect(SmeltArgs.safeParse(args).success).toBe(true);
  });
});

describe('simple tools', () => {
  it('observes with the chosen focus', () => {
    const args = argsFor({ tool: 'observe' });
    expect(ObserveArgs.safeParse(args).success).toBe(true);
    expect(args['focus']).toBe('oak_log');
  });

  it('looks at the target', () => {
    const args = argsFor({ tool: 'look_at' });
    expect(LookAtArgs.safeParse(args).success).toBe(true);
    expect(args['x']).toBe(11);
  });

  it('falls back to the nearest hostile entity when there is no target', () => {
    const args = argsFor({ tool: 'look_at', target: undefined });
    expect(args['x']).toBe(12);
  });

  it('interacts with the target block', () => {
    const args = argsFor({ tool: 'interact' });
    expect(InteractArgs.safeParse(args).success).toBe(true);
    expect(args['block']).toBe('oak_log');
  });

  it('jumps once', () => expect(JumpArgs.safeParse(argsFor({ tool: 'jump' })).success).toBe(true));

  it('pillars higher when urgent', () => {
    expect(argsFor({ tool: 'pillar_up' })['height']).toBe(2);
    expect(argsFor({ tool: 'pillar_up', urgency: 'critical' })['height']).toBe(4);
    expect(PillarUpArgs.safeParse(argsFor({ tool: 'pillar_up' })).success).toBe(true);
  });

  it('toggles sneak and sprint on', () => {
    expect(SneakArgs.safeParse(argsFor({ tool: 'sneak' })).success).toBe(true);
    expect(SprintArgs.safeParse(argsFor({ tool: 'sprint' })).success).toBe(true);
  });

  it('waits longer when calm than when critical', () => {
    expect(argsFor({ tool: 'wait' })['seconds']).toBe(8);
    expect(argsFor({ tool: 'wait', urgency: 'critical' })['seconds']).toBe(1);
    expect(WaitArgs.safeParse(argsFor({ tool: 'wait' })).success).toBe(true);
  });
});

describe('say', () => {
  it('speaks a fixed line, since the model cannot author prose', () => {
    const args = argsFor({ tool: 'say' });
    expect(SayArgs.safeParse(args).success).toBe(true);
    expect(args['message']).toBe('Working on oak_log.');
  });

  it('never starts a line with a slash', () => {
    for (const target of ['oak_log', undefined]) {
      const args = buildArguments(pick({ tool: 'say', target }), observation);
      expect(String(args['message']).startsWith('/')).toBe(false);
    }
  });
});

describe('every builder output satisfies its own schema', () => {
  // smelt is excluded on purpose: without a furnace in reach it correctly
  // returns nothing, and it has its own describe block above.
  const schemas = {
    observe: ObserveArgs,
    mine: MineArgs,
    move_to: MoveToArgs,
    look_at: LookAtArgs,
    interact: InteractArgs,
    attack: AttackArgs,
    eat: EatArgs,
    equip: EquipArgs,
    collect: CollectArgs,
    craft: CraftArgs,
    say: SayArgs,
    jump: JumpArgs,
    pillar_up: PillarUpArgs,
    sneak: SneakArgs,
    sprint: SprintArgs,
    wait: WaitArgs,
  } as const;

  it.each(Object.keys(schemas))('%s', (tool) => {
    const schema = schemas[tool as keyof typeof schemas];
    expect(schema.safeParse(argsFor({ tool })).success).toBe(true);
  });
});

describe('registry coverage', () => {
  it('knows every tool the project registers', () => {
    // place_block is deliberately absent: it needs empty space plus a solid
    // neighbour, which no amount of observation can guarantee.
    for (const tool of [
      'observe', 'mine', 'interact',
      'move_to', 'look_at', 'jump', 'pillar_up', 'sneak', 'sprint', 'wait',
      'attack', 'eat', 'equip', 'collect', 'craft', 'smelt', 'say',
    ]) {
      expect(supportsArgs(tool)).toBe(true);
    }
  });

  it('returns nothing for an unknown tool rather than throwing', () => {
    expect(buildArguments(pick({ tool: 'teleport' }), observation)).toEqual({});
    expect(supportsArgs('teleport')).toBe(false);
  });

  it('never claims to place blocks, because it cannot position them safely', () => {
    expect(supportsArgs('place_block')).toBe(false);
    expect(PlaceBlockArgs.safeParse(argsFor({ tool: 'place_block' })).success).toBe(false);
  });
});