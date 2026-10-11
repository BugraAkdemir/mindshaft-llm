import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';

/** Minimal stand-in for a prismarine-block. */
export interface MockBlock {
  name: string;
  position: Vec3;
  boundingBox: 'block' | 'empty';
  diggable: boolean;
  light: number;
  skyLight: number;
  biome: { name: string };
  isWaterlogged?: boolean;
}

/** Minimal stand-in for a prismarine-item. */
export interface MockItem {
  name: string;
  type: number;
  count: number;
  slot: number;
  maxDurability?: number;
  durabilityUsed?: number;
}

export interface MockEntity {
  id: number;
  name?: string;
  username?: string;
  type: string;
  position: Vec3;
  velocity?: Vec3;
  height: number;
  width: number;
  yaw?: number;
  pitch?: number;
  onGround?: boolean;
  isValid?: boolean;
  health?: number;
  droppedItem?: { name: string; count: number } | null;
  getDroppedItem?: () => { name: string; count: number } | null;
}

export interface MockBotOptions {
  version?: string;
  username?: string;
  position?: Vec3;
  health?: number;
  food?: number;
  oxygenLevel?: number;
  gameMode?: string;
  dimension?: string;
  timeOfDay?: number;
  isDay?: boolean;
  isRaining?: boolean;
  thunderState?: number;
  /** Blocks keyed by "x,y,z". Anything absent reads as air. */
  blocks?: Map<string, string>;
  inventory?: MockItem[];
  entities?: MockEntity[];
  heldItem?: MockItem | null;
}

export interface MockBot extends EventEmitter {
  username: string;
  version: string;
  entity: MockEntity;
  entities: Record<string, MockEntity>;
  health: number;
  food: number;
  oxygenLevel: number;
  game: { gameMode: string; dimension: string };
  time: { timeOfDay: number; isDay: boolean };
  isRaining: boolean;
  thunderState: number;
  heldItem: MockItem | null;
  inventory: {
    slots: Array<MockItem | null>;
    /** First and last slot of the player's own inventory, as the real window reports. */
    inventoryStart: number;
    inventoryEnd: number;
    items: () => MockItem[];
    emptySlotCount: () => number;
    count: (type: number, metadata: number | null) => number;
  };
  pathfinder: {
    thinkTimeout: number;
    tickTimeout: number;
    isMoving: () => boolean;
    isMining: () => boolean;
    isBuilding: () => boolean;
    goto: (goal: unknown) => Promise<void>;
    stop: () => void;
    setGoal: (goal: unknown) => void;
    setMovements: (movements: unknown) => void;
    bestHarvestTool: (block: unknown) => MockItem | null;
  };
  /** Test hooks. */
  __setBlock: (x: number, y: number, z: number, name: string) => void;
  __blocks: Map<string, string>;
  __calls: string[];

  blockAt: (point: Vec3) => MockBlock | null;
  findBlocks: (options: { matching: number | number[] | ((b: unknown) => boolean); maxDistance: number; count?: number }) => Vec3[];
  findBlock: (options: { matching: number | number[]; maxDistance: number }) => MockBlock | null;
  getEquipmentDestSlot: (destination: string) => number;
  waitForTicks: (ticks: number) => Promise<void>;
  waitForChunksToLoad: () => Promise<void>;
  setControlState: (control: string, state: boolean) => void;
  getControlState: (control: string) => boolean;
  clearControlStates: () => void;
  equip: (item: MockItem | number, destination: string | null) => Promise<void>;
  consume: () => Promise<void>;
  canDigBlock: (block: unknown) => boolean;
  dig: (block: unknown, forceLook?: boolean | 'ignore') => Promise<void>;
  stopDigging: () => void;
  placeBlock: (reference: unknown, face: Vec3) => Promise<void>;
  activateBlock: (block: unknown) => Promise<void>;
  lookAt: (point: Vec3, force?: boolean) => Promise<void>;
  look: (yaw: number, pitch: number, force?: boolean) => Promise<void>;
  attack: (entity: unknown) => void;
  quit: (reason?: string) => void;
  recipesFor: (id: number, meta: number | null, min: number | null, table: unknown) => unknown[];
  recipesAll: (id: number, meta: number | null, table: unknown) => unknown[];
  craft: (recipe: unknown, count?: number, table?: unknown) => Promise<void>;
  openFurnace: (block: unknown) => Promise<never>;
}

const BLOCK_DEFAULTS: Record<string, { boundingBox: 'block' | 'empty'; diggable: boolean }> = {
  air: { boundingBox: 'empty', diggable: false },
  cave_air: { boundingBox: 'empty', diggable: false },
  water: { boundingBox: 'empty', diggable: false },
  lava: { boundingBox: 'empty', diggable: false },
  bedrock: { boundingBox: 'block', diggable: false },
};

export function key(x: number, y: number, z: number): string {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

/**
 * Builds a fake Mineflayer bot good enough to drive the observer, the tool
 * registry, the safety layer and a full agent cycle without a server.
 */
export function createMockBot(options: MockBotOptions = {}): MockBot {
  const emitter = new EventEmitter();
  const position = options.position ?? new Vec3(0.5, 64, 0.5);
  const blocks = options.blocks ?? new Map<string, string>();
  const inventory = [...(options.inventory ?? [])];
  const inventorySlots: Array<MockItem | null> = new Array<MockItem | null>(46).fill(null);
  for (const item of inventory) inventorySlots[item.slot] = item;
  const controls: Record<string, boolean> = {};
  const calls: string[] = [];

  const self: MockEntity = {
    id: 1,
    name: 'player',
    username: options.username ?? 'TestAgent',
    type: 'player',
    position,
    velocity: new Vec3(0, 0, 0),
    height: 1.8,
    width: 0.6,
    yaw: 0,
    pitch: 0,
    onGround: true,
    isValid: true,
  };

  const entityMap: Record<string, MockEntity> = { '1': self };
  for (const entity of options.entities ?? []) {
    entityMap[String(entity.id)] = {
      isValid: true,
      velocity: new Vec3(0, 0, 0),
      ...entity,
      getDroppedItem: entity.getDroppedItem ?? (() => entity.droppedItem ?? null),
    };
  }

  function blockAt(point: Vec3): MockBlock | null {
    const name = blocks.get(key(point.x, point.y, point.z)) ?? 'air';
    const defaults = BLOCK_DEFAULTS[name] ?? { boundingBox: 'block' as const, diggable: true };
    return {
      name,
      position: new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)),
      boundingBox: defaults.boundingBox,
      diggable: defaults.diggable,
      light: 15,
      skyLight: 15,
      biome: { name: 'plains' },
    };
  }

  const bot = Object.assign(emitter, {
    username: options.username ?? 'TestAgent',
    version: options.version ?? '1.21.4',
    entity: self,
    entities: entityMap,
    health: options.health ?? 20,
    food: options.food ?? 20,
    oxygenLevel: options.oxygenLevel ?? 20,
    game: { gameMode: options.gameMode ?? 'survival', dimension: options.dimension ?? 'overworld' },
    time: { timeOfDay: options.timeOfDay ?? 6_000, isDay: options.isDay ?? true },
    isRaining: options.isRaining ?? false,
    thunderState: options.thunderState ?? 0,
    heldItem: options.heldItem ?? null,

    inventory: {
      // `slots` is the single source of truth, mirroring the real window: slot
      // 0 is the crafting result, 1-4 the 2x2 grid, 5-8 armour, 9-45 the
      // player's inventory. `items()` is derived from it.
      slots: inventorySlots,
      inventoryStart: 9,
      inventoryEnd: 45,
      items: () => inventorySlots.filter((item): item is MockItem => item !== null),
      emptySlotCount: () => inventorySlots.filter((item) => item === null).length,
      count: (type: number) =>
        inventorySlots
          .filter((item): item is MockItem => item !== null && item.type === type)
          .reduce((total, item) => total + item.count, 0),
    },

    pathfinder: {
      thinkTimeout: 5_000,
      tickTimeout: 40,
      isMoving: () => false,
      isMining: () => false,
      isBuilding: () => false,
      goto: async () => {
        calls.push('pathfinder.goto');
      },
      stop: () => {
        calls.push('pathfinder.stop');
      },
      setGoal: () => undefined,
      setMovements: () => undefined,
      bestHarvestTool: () => null,
    },

    __blocks: blocks,
    __calls: calls,
    __setBlock: (x: number, y: number, z: number, name: string) => {
      blocks.set(key(x, y, z), name);
    },

    blockAt,

    /**
     * Mirrors `bot.findBlocks`: matches by numeric block id, respects
     * `maxDistance`, and returns results NEAREST FIRST before applying `count`.
     * Ordering matters — callers rely on the first result being the closest.
     */
    findBlocks: (opts: { matching: number | number[] | ((b: unknown) => boolean); maxDistance: number; count?: number }) => {
      const limit = opts.count ?? 1;
      const radius = Math.ceil(opts.maxDistance);
      const matchIds = new Set(Array.isArray(opts.matching) ? opts.matching : [opts.matching as number]);
      const version = options.version ?? '1.21.4';

      const found: Array<{ position: Vec3; distance: number }> = [];
      for (const [position, name] of blocks) {
        const [x, y, z] = position.split(',').map(Number) as [number, number, number];
        if (Math.abs(x - self.position.x) > radius) continue;
        if (Math.abs(y - self.position.y) > radius) continue;
        if (Math.abs(z - self.position.z) > radius) continue;

        const id = blockIdFor(name, version);
        if (id === null || !matchIds.has(id)) continue;

        const dx = x + 0.5 - self.position.x;
        const dy = y + 0.5 - self.position.y;
        const dz = z + 0.5 - self.position.z;
        found.push({ position: new Vec3(x, y, z), distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
      }

      return found
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map((entry) => entry.position);
    },

    findBlock: (opts: { matching: number | number[]; maxDistance: number }) => {
      const results = bot.findBlocks({ ...opts, count: 1 });
      const first = results[0];
      return first ? blockAt(first) : null;
    },

    getEquipmentDestSlot: (destination: string) => {
      const slots: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45, hand: 36 };
      const slot = slots[destination];
      if (slot === undefined) throw new Error(`unknown destination ${destination}`);
      return slot;
    },

    waitForTicks: async (ticks: number) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ticks, 2)));
    },
    waitForChunksToLoad: async () => undefined,

    setControlState: (control: string, state: boolean) => {
      controls[control] = state;
      calls.push(`control:${control}=${state}`);
    },
    getControlState: (control: string) => controls[control] ?? false,
    clearControlStates: () => {
      for (const control of Object.keys(controls)) controls[control] = false;
    },

    equip: async (item: MockItem | number) => {
      calls.push(`equip:${typeof item === 'number' ? item : item.name}`);
      if (typeof item !== 'number') bot.heldItem = item;
    },
    consume: async () => {
      calls.push('consume');
      bot.food = Math.min(20, bot.food + 5);
    },

    canDigBlock: () => true,
    dig: async () => {
      calls.push('dig');
    },
    stopDigging: () => {
      calls.push('stopDigging');
    },
    placeBlock: async () => {
      calls.push('placeBlock');
    },
    activateBlock: async () => {
      calls.push('activateBlock');
    },
    lookAt: async () => {
      calls.push('lookAt');
    },
    look: async (yaw: number, pitch: number) => {
      self.yaw = yaw;
      self.pitch = pitch;
    },
    attack: () => {
      calls.push('attack');
    },
    quit: () => {
      calls.push('quit');
    },
    recipesFor: () => [],
    recipesAll: () => [],
    craft: async () => {
      calls.push('craft');
    },
    openFurnace: async () => {
      throw new Error('no furnace in mock');
    },
  }) as unknown as MockBot;

  return bot;
}

/** Resolves a block name to its numeric id using real minecraft-data. */
function blockIdFor(name: string, version: string): number | null {
  const cached = cachedRegistry?.version === version ? cachedRegistry.data : null;
  const data = cached ?? minecraftData(version);
  cachedRegistry = { version, data };
  return data.blocksByName[name]?.id ?? null;
}

let cachedRegistry: { version: string; data: ReturnType<typeof minecraftData> } | null = null;

/** Casts the mock to the Mineflayer `Bot` type at the single point of use. */
export function asBot(bot: MockBot): Bot {
  return bot as unknown as Bot;
}
