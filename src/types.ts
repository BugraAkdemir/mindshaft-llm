import type { Direction, Point3 } from './utils/spatial.js';

/* ────────────────────────────── World state ───────────────────────────── */

export interface PlayerState {
  position: Point3;
  velocity: Point3;
  health: number;
  food: number;
  oxygen: number;
  gamemode: string;
  dimension: string;
  yaw: number;
  pitch: number;
  facing: Direction;
  onGround: boolean;
  isInWater: boolean;
  heldItem: string | null;
  equipment: Record<string, string>;
}

export interface EnvironmentState {
  time: number;
  timeOfDay: string;
  isDay: boolean;
  weather: 'clear' | 'rain' | 'thunder';
  lightLevel: number;
  biome: string;
  standingOn: string | null;
  /**
   * Set when the bot is boxed in on all four sides by walls it cannot jump —
   * typically a hole it dug itself into. `pillar_up` is the way out.
   */
  stuckInPit: boolean;
  /** How many of the four horizontal sides are blocked at head height. */
  blockedSides: number;
}

export interface InventoryEntry {
  item: string;
  count: number;
  slots: number[];
  /** Percentage of durability remaining; omitted for items without durability. */
  durability?: number;
}

/**
 * Aggregated view of many blocks of the same type. Returning one entry per
 * block would blow the context window on the first tree the bot walks past.
 */
export interface BlockGroup {
  type: string;
  count: number;
  nearest: Point3;
  distance: number;
  direction: Direction;
  relative: Point3;
}

export interface EntityInfo {
  id: number;
  type: string;
  name: string;
  category: 'hostile' | 'passive' | 'player' | 'villager' | 'item' | 'other';
  position: Point3;
  distance: number;
  direction: Direction;
  relative: Point3;
  health?: number;
  /** Set for dropped-item entities when the stack could be identified. */
  itemName?: string;
  itemCount?: number;
}

export interface WorldState {
  tick: number;
  player: PlayerState;
  environment: EnvironmentState;
  nearbyBlocks: BlockGroup[];
  entities: EntityInfo[];
  inventory: InventoryEntry[];
  /** Counts of the bot's own inventory keyed by item name, for quick checks. */
  inventoryCounts: Record<string, number>;
  nearbyPlayers: string[];
  threats: EntityInfo[];
}

/* ───────────────────────────── Tool results ───────────────────────────── */

export type ToolErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'UNKNOWN_TOOL'
  | 'PATH_NOT_FOUND'
  | 'PATH_TIMEOUT'
  | 'PATH_INTERRUPTED'
  | 'TARGET_TOO_FAR'
  | 'TARGET_NOT_FOUND'
  | 'BLOCK_NOT_FOUND'
  | 'BLOCK_NOT_DIGGABLE'
  | 'ENTITY_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'UNKNOWN_ITEM'
  | 'UNKNOWN_BLOCK'
  | 'NO_RECIPE'
  | 'MISSING_INGREDIENTS'
  | 'CRAFTING_TABLE_REQUIRED'
  | 'FURNACE_REQUIRED'
  | 'NO_FUEL'
  | 'NOT_EDIBLE'
  | 'INVENTORY_FULL'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'UNSAFE'
  | 'NOT_CONNECTED'
  | 'MINEFLAYER_ERROR';

export interface ToolSuccess<T = unknown> {
  success: true;
  data: T;
  durationMs: number;
}

export interface ToolFailure {
  success: false;
  error: ToolErrorCode;
  details: string;
  durationMs: number;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export function ok<T>(data: T, durationMs = 0): ToolSuccess<T> {
  return { success: true, data, durationMs };
}

export function fail(error: ToolErrorCode, details: string, durationMs = 0): ToolFailure {
  return { success: false, error, details, durationMs };
}

/* ──────────────────────────── Agent decisions ─────────────────────────── */

export interface AgentDecision {
  reason: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Optional model-supplied note that gets promoted into long-lived memory. */
  remember?: string;
  /** Set when the model believes the overall goal is complete. */
  goalComplete?: boolean;
}

export interface ActionRecord {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  success: boolean;
  error?: ToolErrorCode;
  details?: string;
  durationMs: number;
  at: number;
}

export interface AgentEvent {
  /** Human-readable, already-aggregated description, e.g. "health dropped to 6". */
  message: string;
  severity: 'info' | 'warn' | 'critical';
  at: number;
}
