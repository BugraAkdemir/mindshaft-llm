import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { fail, ok, type ToolResult } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';
import {
  distance as dist,
  floorPoint,
  isSaneCoordinate,
  round,
  roundPoint,
  toPoint,
  type Point3,
} from '../utils/spatial.js';
import type { InventoryManager } from './inventory.js';
import type { MovementController } from './movement.js';
import type { GameRegistry } from './registry.js';

/** Blocks the agent is never allowed to break — losing them is unrecoverable. */
const PROTECTED_BLOCKS = new Set([
  'bedrock',
  'end_portal',
  'end_portal_frame',
  'end_gateway',
  'nether_portal',
  'barrier',
  'command_block',
  'chain_command_block',
  'repeating_command_block',
  'structure_block',
  'structure_void',
  'jigsaw',
  'light',
  'reinforced_deepslate',
]);

/**
 * Mineflayer measures reach from the bot's EYE (`position + 1.65`) to the block
 * centre, and refuses beyond 5.1. Measuring from the feet — as an earlier
 * version did — silently under-reports the distance to blocks *below* the bot,
 * so the agent would decide it was already in range and then fail to dig.
 */
const EYE_HEIGHT = 1.62;
/** Walk closer past this eye-distance, leaving margin under Mineflayer's 5.1. */
const INTERACT_REACH = 3.8;

/** Ticks allowed for a jump to clear one block of height. */
const JUMP_APEX_TICKS = 12;

/**
 * Blocks the bot may spend on a pillar, cheapest and most expendable first, so
 * escaping a hole never burns diamonds or a crafting table.
 */
const PILLAR_BLOCK_PRIORITY: RegExp[] = [
  /^dirt$/,
  /^coarse_dirt$/,
  /^(grass_block|podzol|mycelium)$/,
  /^(sand|red_sand|gravel)$/,
  /^cobblestone$/,
  /^cobbled_deepslate$/,
  /^(stone|deepslate|andesite|diorite|granite|tuff|netherrack|basalt|blackstone)$/,
  /_planks$/,
  /^(clay|snow_block|packed_mud|mud_bricks)$/,
  /^(oak_log|birch_log|spruce_log|jungle_log|acacia_log|dark_oak_log|mangrove_log|cherry_log)$/,
  /^(cobblestone_slab|stone_bricks|bricks|sandstone|terracotta)$/,
];

/** Ticks to wait after a dig for the server to spawn the dropped-item entity. */
const DROP_SPAWN_TICKS = 6;
/** Extra ticks for an automatic (walk-over) pickup to be confirmed. */
const DROP_PICKUP_TICKS = 6;

/** Faces tried, in order, when looking for a surface to place against. */
const PLACEMENT_FACES: Array<{ offset: Vec3; face: Vec3 }> = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
];

export interface MineOutcome {
  block: string;
  position: Point3;
  tool: string | null;
  drops: Array<{ item: string; count: number }>;
  durationMs: number;
}

export interface PlaceOutcome {
  block: string;
  position: Point3;
  against: { block: string; position: Point3 };
}

/**
 * Block-level actions: mining, placing, interacting and aiming.
 *
 * Each action resolves and re-reads the target block from the live world before
 * touching it, because the LLM's view of the world is always at least one tick
 * stale and the block it named may already be gone.
 */
export class BlockActions {
  private readonly bot: Bot;
  private readonly registry: GameRegistry;
  private readonly movement: MovementController;
  private readonly inventory: InventoryManager;
  private readonly log: Logger;

  public constructor(
    bot: Bot,
    registry: GameRegistry,
    movement: MovementController,
    inventory: InventoryManager,
    logger?: Logger,
  ) {
    this.bot = bot;
    this.registry = registry;
    this.movement = movement;
    this.inventory = inventory;
    this.log = tagged('TOOL', logger);
  }

  /* ──────────────────────── target block resolution ───────────────────── */

  /**
   * Finds the block to act on. With an explicit position the block there must
   * match `blockName` (when given); without one, the nearest matching block
   * inside `searchRadius` is used.
   */
  public resolveTargetBlock(
    blockName: string | undefined,
    position: Point3 | undefined,
    searchRadius: number,
  ): { block: Block } | { error: ToolResult<never> } {
    if (position) {
      if (!isSaneCoordinate(position)) {
        return { error: fail('UNSAFE', `Position ${JSON.stringify(position)} is outside world bounds.`) };
      }
      const floored = floorPoint(position);
      const block = this.bot.blockAt(new Vec3(floored.x, floored.y, floored.z));
      if (!block) {
        return {
          error: fail(
            'BLOCK_NOT_FOUND',
            `No loaded block at (${floored.x}, ${floored.y}, ${floored.z}) — move closer so the chunk loads.`,
          ),
        };
      }
      if (blockName) {
        const resolved = this.registry.resolveBlock(blockName);
        if (!resolved) {
          const suggestions = this.registry.suggestBlockNames(blockName);
          return {
            error: fail(
              'UNKNOWN_BLOCK',
              `"${blockName}" is not a block in Minecraft ${this.registry.version}.` +
                (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
            ),
          };
        }
        if (block.name !== resolved.name) {
          return {
            error: fail(
              'BLOCK_NOT_FOUND',
              `Expected ${resolved.name} at (${floored.x}, ${floored.y}, ${floored.z}) but found ${block.name}. ` +
                'Observe again — the world has changed.',
            ),
          };
        }
      }
      return { block };
    }

    if (!blockName) {
      return { error: fail('INVALID_ARGUMENTS', 'Provide either a block name, a position, or both.') };
    }

    const resolved = this.registry.resolveBlock(blockName);
    if (!resolved) {
      const suggestions = this.registry.suggestBlockNames(blockName);
      return {
        error: fail(
          'UNKNOWN_BLOCK',
          `"${blockName}" is not a block in Minecraft ${this.registry.version}.` +
            (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
        ),
      };
    }

    const found = this.bot.findBlock({ matching: resolved.id, maxDistance: searchRadius });
    if (!found) {
      return {
        error: fail(
          'BLOCK_NOT_FOUND',
          `No ${resolved.name} within ${searchRadius} blocks. Explore or observe first.`,
        ),
      };
    }
    return { block: found };
  }

  /* ──────────────────────────────── mining ────────────────────────────── */

  public async mine(
    target: { blockName?: string; position?: Point3 },
    options: { searchRadius: number; timeoutMs: number; collectDrops: boolean; signal?: AbortSignal },
  ): Promise<ToolResult<MineOutcome>> {
    const startedAt = Date.now();
    const resolution = this.resolveTargetBlock(target.blockName, target.position, options.searchRadius);
    if ('error' in resolution) return resolution.error;

    const block = resolution.block;

    if (PROTECTED_BLOCKS.has(block.name)) {
      return fail('UNSAFE', `${block.name} must never be broken.`, Date.now() - startedAt);
    }
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      return fail(
        'BLOCK_NOT_FOUND',
        `Nothing to mine at (${block.position.x}, ${block.position.y}, ${block.position.z}) — it is air.`,
        Date.now() - startedAt,
      );
    }
    if (block.diggable === false) {
      return fail('BLOCK_NOT_DIGGABLE', `${block.name} cannot be dug.`, Date.now() - startedAt);
    }

    // Approach until the block is in reach, measured the way Mineflayer will.
    if (reachDistance(this.bot, toPoint(block.position)) > INTERACT_REACH) {
      const move = await this.movement.moveToBlock(toPoint(block.position), {
        reach: 2.5,
        timeoutMs: Math.max(3_000, Math.floor(options.timeoutMs * 0.6)),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!move.success) {
        return fail(
          move.error,
          `Could not reach ${block.name} at (${block.position.x}, ${block.position.y}, ${block.position.z}): ${move.details}`,
          Date.now() - startedAt,
        );
      }
    }

    // Re-read: the block may have changed while we walked.
    let live = this.bot.blockAt(block.position);
    if (!live || live.name !== block.name) {
      return fail(
        'BLOCK_NOT_FOUND',
        `${block.name} at (${block.position.x}, ${block.position.y}, ${block.position.z}) is now ${live?.name ?? 'unloaded'}.`,
        Date.now() - startedAt,
      );
    }

    // Standing where the pathfinder left us can still be a hair out of reach —
    // most often for a block below the bot. Close the gap once before failing.
    if (!this.bot.canDigBlock(live)) {
      const closer = await this.movement.moveToBlock(toPoint(block.position), {
        reach: 1.5,
        timeoutMs: Math.max(2_500, Math.floor(options.timeoutMs * 0.3)),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      live = this.bot.blockAt(block.position) ?? live;

      if (!this.bot.canDigBlock(live)) {
        return fail(
          'BLOCK_NOT_DIGGABLE',
          `${live.name} at (${block.position.x}, ${block.position.y}, ${block.position.z}) stays out of reach ` +
            `(${round(reachDistance(this.bot, toPoint(block.position)), 1)} blocks from the bot's eyes; the limit is 5). ` +
            (closer.success
              ? 'Clear a path to it, or approach from a different side.'
              : `Could not get closer: ${closer.details}`),
          Date.now() - startedAt,
        );
      }
    }

    const tool = await this.inventory.equipBestToolFor(live);
    const before = this.inventorySnapshot();

    const remainingMs = options.timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 250) {
      return fail('TIMEOUT', 'Ran out of time before digging could start.', Date.now() - startedAt);
    }

    try {
      await withTimeout(
        this.bot.dig(live, true),
        remainingMs,
        () => this.bot.stopDigging(),
        `Digging ${live.name} exceeded ${remainingMs}ms`,
      );
    } catch (err) {
      this.bot.stopDigging();
      if (err instanceof ActionTimeout) {
        return fail('TIMEOUT', err.message, Date.now() - startedAt);
      }
      return fail(
        'MINEFLAYER_ERROR',
        `Failed to dig ${live.name}: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - startedAt,
      );
    }

    // The server spawns the dropped-item entity a few ticks after the block
    // breaks. Measuring the inventory before that reports an empty `drops` list
    // even though the item is about to land, so settle first.
    await this.bot.waitForTicks(DROP_SPAWN_TICKS);

    if (options.collectDrops) {
      const collectOptions = {
        radius: 4,
        maxItems: 3,
        timeoutMs: Math.max(1_500, Math.min(6_000, options.timeoutMs - (Date.now() - startedAt))),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      await this.inventory.collect(collectOptions);
      // Drops that land at the bot's feet are picked up automatically; give
      // that packet time to arrive before diffing the inventory.
      await this.bot.waitForTicks(DROP_PICKUP_TICKS);
    }

    const durationMs = Date.now() - startedAt;
    return ok(
      {
        block: live.name,
        position: toPoint(live.position),
        tool,
        drops: this.inventoryDelta(before),
        durationMs,
      },
      durationMs,
    );
  }

  /* ─────────────────────────────── placing ────────────────────────────── */

  public async place(
    itemName: string,
    position: Point3,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ToolResult<PlaceOutcome>> {
    const startedAt = Date.now();

    if (!isSaneCoordinate(position)) {
      return fail('UNSAFE', `Position ${JSON.stringify(position)} is outside world bounds.`);
    }

    const resolved = this.registry.resolveItem(itemName);
    if (!resolved) {
      const suggestions = this.registry.suggestItemNames(itemName);
      return fail(
        'UNKNOWN_ITEM',
        `"${itemName}" is not a known item.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
      );
    }
    if (!this.inventory.findItem(resolved.name)) {
      return fail(
        'ITEM_NOT_FOUND',
        `No ${resolved.name} in inventory. Carrying: ${this.inventory.summarize()}`,
      );
    }

    const target = floorPoint(position);
    const targetVec = new Vec3(target.x, target.y, target.z);
    const existing = this.bot.blockAt(targetVec);
    if (existing && !isReplaceable(existing.name)) {
      return fail(
        'UNSAFE',
        `(${target.x}, ${target.y}, ${target.z}) already contains ${existing.name}; mine it first.`,
      );
    }

    // Get within reach of the destination before searching for a face.
    if (reachDistance(this.bot, target) > INTERACT_REACH) {
      const move = await this.movement.moveTo(
        { x: target.x + 0.5, y: target.y, z: target.z + 0.5 },
        {
          range: 2.5,
          timeoutMs: Math.max(3_000, Math.floor(options.timeoutMs * 0.6)),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (!move.success) {
        return fail(move.error, `Could not reach the placement spot: ${move.details}`);
      }
    }

    const surface = this.findPlacementFace(targetVec);
    if (!surface) {
      return fail(
        'UNSAFE',
        `No solid face adjacent to (${target.x}, ${target.y}, ${target.z}) to place against. ` +
          'Blocks need an existing neighbour to attach to.',
      );
    }

    const item = this.inventory.findItem(resolved.name);
    /* c8 ignore next — presence was checked above; this guards a race. */
    if (!item) return fail('ITEM_NOT_FOUND', `${resolved.name} disappeared from inventory.`);

    try {
      await this.bot.equip(item, 'hand');
      const remainingMs = options.timeoutMs - (Date.now() - startedAt);
      await withTimeout(
        this.bot.placeBlock(surface.reference, surface.face),
        Math.max(1_000, remainingMs),
        undefined,
        `Placing ${resolved.name} exceeded ${Math.max(1_000, remainingMs)}ms`,
      );
    } catch (err) {
      if (err instanceof ActionTimeout) {
        return fail('TIMEOUT', err.message, Date.now() - startedAt);
      }
      return fail(
        'MINEFLAYER_ERROR',
        `Failed to place ${resolved.name}: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - startedAt,
      );
    }

    this.movement.invalidateMovements();
    const placed = this.bot.blockAt(targetVec);
    const durationMs = Date.now() - startedAt;

    return ok(
      {
        block: placed?.name ?? resolved.name,
        position: target,
        against: {
          block: surface.reference.name,
          position: toPoint(surface.reference.position),
        },
      },
      durationMs,
    );
  }

  /** Finds a solid neighbour of `target` plus the face vector pointing at `target`. */
  private findPlacementFace(target: Vec3): { reference: Block; face: Vec3 } | null {
    for (const candidate of PLACEMENT_FACES) {
      const referencePos = target.plus(candidate.offset);
      const reference = this.bot.blockAt(referencePos);
      if (!reference) continue;
      if (reference.boundingBox !== 'block') continue;
      if (isReplaceable(reference.name)) continue;
      return { reference, face: candidate.face };
    }
    return null;
  }

  /* ───────────────────────────── interaction ──────────────────────────── */

  /**
   * Right-clicks a block: doors, buttons, levers, beds, crops and so on.
   * Containers are handled by dedicated tools instead.
   */
  public async interact(
    target: { blockName?: string; position?: Point3 },
    options: { searchRadius: number; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ToolResult<{ block: string; position: Point3 }>> {
    const startedAt = Date.now();
    const resolution = this.resolveTargetBlock(target.blockName, target.position, options.searchRadius);
    if ('error' in resolution) return resolution.error;

    const block = resolution.block;

    if (reachDistance(this.bot, toPoint(block.position)) > INTERACT_REACH) {
      const move = await this.movement.moveToBlock(toPoint(block.position), {
        reach: 2.5,
        timeoutMs: Math.max(3_000, Math.floor(options.timeoutMs * 0.6)),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!move.success) {
        return fail(move.error, `Could not reach ${block.name}: ${move.details}`);
      }
    }

    const live = this.bot.blockAt(block.position);
    if (!live) {
      return fail('BLOCK_NOT_FOUND', 'Target block is no longer loaded.');
    }

    try {
      await this.bot.lookAt(centreOf(live), true);
      const remainingMs = Math.max(1_000, options.timeoutMs - (Date.now() - startedAt));
      await withTimeout(
        this.bot.activateBlock(live),
        remainingMs,
        undefined,
        `Interacting with ${live.name} exceeded ${remainingMs}ms`,
      );
    } catch (err) {
      if (err instanceof ActionTimeout) {
        return fail('TIMEOUT', err.message, Date.now() - startedAt);
      }
      return fail(
        'MINEFLAYER_ERROR',
        `Could not interact with ${live.name}: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - startedAt,
      );
    }

    return ok({ block: live.name, position: toPoint(live.position) }, Date.now() - startedAt);
  }

  /* ────────────────────────────── look / jump ─────────────────────────── */

  public async lookAt(
    target: { position?: Point3; entityId?: number; yaw?: number; pitch?: number },
  ): Promise<ToolResult<{ lookedAt: string; yaw: number; pitch: number }>> {
    try {
      if (target.entityId !== undefined) {
        const entity = this.bot.entities[target.entityId];
        if (!entity?.position) {
          return fail('ENTITY_NOT_FOUND', `No entity with id ${target.entityId} nearby.`);
        }
        await this.bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0), true);
        return ok({
          lookedAt: entity.username ?? entity.name ?? `entity ${target.entityId}`,
          yaw: round(this.bot.entity.yaw, 2),
          pitch: round(this.bot.entity.pitch, 2),
        });
      }

      if (target.position) {
        if (!isSaneCoordinate(target.position)) {
          return fail('UNSAFE', 'Look target is outside world bounds.');
        }
        await this.bot.lookAt(
          new Vec3(target.position.x, target.position.y, target.position.z),
          true,
        );
        return ok({
          lookedAt: `(${target.position.x}, ${target.position.y}, ${target.position.z})`,
          yaw: round(this.bot.entity.yaw, 2),
          pitch: round(this.bot.entity.pitch, 2),
        });
      }

      if (target.yaw !== undefined || target.pitch !== undefined) {
        const yaw = target.yaw ?? this.bot.entity.yaw;
        const pitch = target.pitch ?? this.bot.entity.pitch;
        await this.bot.look(yaw, pitch, true);
        return ok({ lookedAt: `yaw=${round(yaw, 2)} pitch=${round(pitch, 2)}`, yaw: round(yaw, 2), pitch: round(pitch, 2) });
      }

      return fail('INVALID_ARGUMENTS', 'Provide a position, an entity_id, or yaw/pitch.');
    } catch (err) {
      return fail('MINEFLAYER_ERROR', `Look failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ──────────────────────────── escaping pits ─────────────────────────── */

  /**
   * Describes how boxed-in the bot is, so both the model and the reactive layer
   * can tell "standing in a hole I dug" from "walking across open ground".
   */
  public describeEnclosure(): {
    enclosed: boolean;
    wallHeight: number;
    blockedSides: number;
    hasCeiling: boolean;
  } {
    const feet = this.bot.entity.position.floored();
    const sides: Vec3[] = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];

    let blockedSides = 0;
    let wallHeight = 0;

    for (const side of sides) {
      // A side counts as blocked when both the foot and head slots are solid.
      const atFeet = this.bot.blockAt(feet.plus(side));
      const atHead = this.bot.blockAt(feet.plus(side).offset(0, 1, 0));
      const footSolid = atFeet !== null && atFeet.boundingBox === 'block';
      const headSolid = atHead !== null && atHead.boundingBox === 'block';
      if (footSolid && headSolid) blockedSides += 1;

      // How high the wall on this side runs, up to a useful ceiling.
      if (footSolid && headSolid) {
        let height = 2;
        for (let dy = 2; dy < 5; dy += 1) {
          const above = this.bot.blockAt(feet.plus(side).offset(0, dy, 0));
          if (above === null || above.boundingBox !== 'block') break;
          height += 1;
        }
        wallHeight = Math.max(wallHeight, height);
      }
    }

    const ceiling = this.bot.blockAt(feet.offset(0, 2, 0));
    const hasCeiling = ceiling !== null && ceiling.boundingBox === 'block';

    return {
      // Boxed in on every side by a wall at least two blocks high: the bot
      // cannot walk or jump out, and must build its way up.
      enclosed: blockedSides === 4 && wallHeight >= 2,
      wallHeight,
      blockedSides,
      hasCeiling,
    };
  }

  /** Blocks worth spending to build a pillar, cheapest first. */
  private findPillarBlock(): Item | null {
    const items = this.bot.inventory.items();
    let best: { item: Item; rank: number } | null = null;

    for (const item of items) {
      const rank = PILLAR_BLOCK_PRIORITY.findIndex((pattern) => pattern.test(item.name));
      if (rank === -1) continue;
      if (!best || rank < best.rank) best = { item, rank };
    }
    return best?.item ?? null;
  }

  /**
   * Builds a pillar straight up, placing a block under the bot's own feet on
   * each jump — the standard way out of a hole the bot dug itself into.
   *
   * Mineflayer cannot place a block into a space the bot occupies, so each step
   * jumps first and places at the apex, against the block the bot just left.
   */
  public async pillarUp(
    height: number,
    options: { itemName?: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ToolResult<{ placed: number; from: Point3; to: Point3; block: string }>> {
    const startedAt = Date.now();
    const from = toPoint(this.bot.entity.position);

    let chosen: Item | null;
    if (options.itemName) {
      const resolved = this.registry.resolveItem(options.itemName);
      if (!resolved) {
        return fail('UNKNOWN_ITEM', `"${options.itemName}" is not a known item.`);
      }
      chosen = this.inventory.findItem(resolved.name);
      if (!chosen) {
        return fail(
          'ITEM_NOT_FOUND',
          `No ${resolved.name} to build with. Carrying: ${this.inventory.summarize()}`,
        );
      }
    } else {
      chosen = this.findPillarBlock();
      if (!chosen) {
        return fail(
          'ITEM_NOT_FOUND',
          'No placeable building blocks in inventory (dirt, cobblestone, planks and similar all work). ' +
            `Carrying: ${this.inventory.summarize()}`,
        );
      }
    }

    const blockName = chosen.name;
    const available = this.inventory.countItem(blockName);
    const steps = Math.min(height, available);
    let placed = 0;

    try {
      await this.bot.equip(chosen, 'hand');
    } catch (err) {
      return fail('MINEFLAYER_ERROR', `Could not hold ${blockName}: ${describeError(err)}`);
    }

    for (let step = 0; step < steps; step += 1) {
      if (options.signal?.aborted) break;
      if (Date.now() - startedAt > options.timeoutMs - 1_000) break;

      const standingOn = this.bot.entity.position.floored().offset(0, -1, 0);
      const support = this.bot.blockAt(standingOn);
      if (!support || support.boundingBox !== 'block') {
        // Nothing underfoot to build on — the bot is falling or swimming.
        break;
      }

      const beforeY = this.bot.entity.position.y;

      try {
        // Look down so the placement raycast hits the block below.
        await this.bot.look(this.bot.entity.yaw, Math.PI / 2, true);
        this.bot.setControlState('jump', true);

        // Place at the apex, once clear of the space the new block will fill.
        let rose = false;
        for (let tick = 0; tick < JUMP_APEX_TICKS; tick += 1) {
          await this.bot.waitForTicks(1);
          if (this.bot.entity.position.y - beforeY >= 1.05) {
            rose = true;
            break;
          }
        }
        this.bot.setControlState('jump', false);

        if (!rose) {
          // Jump was blocked — most likely a ceiling directly overhead.
          const ceiling = this.bot.blockAt(this.bot.entity.position.floored().offset(0, 2, 0));
          return placed > 0
            ? ok(
                { placed, from: roundPoint(from, 1), to: roundPoint(toPoint(this.bot.entity.position), 1), block: blockName },
                Date.now() - startedAt,
              )
            : fail(
                'UNSAFE',
                `Could not jump: ${ceiling && ceiling.boundingBox === 'block' ? `${ceiling.name} directly overhead — mine it first` : 'the jump was blocked'}.`,
                Date.now() - startedAt,
              );
        }

        await this.bot.placeBlock(support, new Vec3(0, 1, 0));
        placed += 1;
        // Let the bot settle onto the block it just placed.
        await this.bot.waitForTicks(4);
      } catch (err) {
        this.bot.setControlState('jump', false);
        if (placed > 0) break; // keep the progress already made
        return fail(
          'MINEFLAYER_ERROR',
          `Could not place ${blockName} underfoot: ${describeError(err)}`,
          Date.now() - startedAt,
        );
      }
    }

    this.bot.setControlState('jump', false);
    this.movement.invalidateMovements();

    if (placed === 0) {
      return fail(
        'UNSAFE',
        `Could not build upward with ${blockName}. There may be no solid ground underfoot or no headroom.`,
        Date.now() - startedAt,
      );
    }

    return ok(
      {
        placed,
        from: roundPoint(from, 1),
        to: roundPoint(toPoint(this.bot.entity.position), 1),
        block: blockName,
      },
      Date.now() - startedAt,
    );
  }

  /* ───────────────────────── inventory diffing ────────────────────────── */

  private inventorySnapshot(): Map<string, number> {
    const snapshot = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      snapshot.set(item.name, (snapshot.get(item.name) ?? 0) + item.count);
    }
    return snapshot;
  }

  /** Items gained since `before` — how the agent learns what a block dropped. */
  private inventoryDelta(before: Map<string, number>): Array<{ item: string; count: number }> {
    const after = this.inventorySnapshot();
    const delta: Array<{ item: string; count: number }> = [];
    for (const [name, count] of after) {
      const gained = count - (before.get(name) ?? 0);
      if (gained > 0) delta.push({ item: name, count: gained });
    }
    return delta.sort((a, b) => b.count - a.count);
  }
}

/* ────────────────────────────── local helpers ─────────────────────────── */

export class ActionTimeout extends Error {
  public override readonly name = 'ActionTimeout';
}

/**
 * Races a Mineflayer promise against a deadline, running `onTimeout` so the bot
 * is not left mid-action (e.g. still holding down the dig button).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: (() => void) | undefined,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ActionTimeout(message));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // The losing promise may still reject later; swallow it.
    void promise.catch(() => undefined);
  }
}

const REPLACEABLE = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'flowing_water',
  'lava',
  'flowing_lava',
  'grass',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'seagrass',
  'snow',
  'fire',
  'soul_fire',
  'vine',
  'light',
  'structure_void',
]);

export function isReplaceable(blockName: string): boolean {
  return REPLACEABLE.has(blockName);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function centreOf(block: Block): Vec3 {
  return block.position.offset(0.5, 0.5, 0.5);
}

/** The point Mineflayer measures reach from. */
function eyeOf(bot: Bot): Point3 {
  const position = bot.entity.position;
  return { x: position.x, y: position.y + EYE_HEIGHT, z: position.z };
}

/** Eye-to-block-centre distance, matching Mineflayer's own reach test. */
function reachDistance(bot: Bot, blockPosition: Point3): number {
  return dist(eyeOf(bot), {
    x: Math.floor(blockPosition.x) + 0.5,
    y: Math.floor(blockPosition.y) + 0.5,
    z: Math.floor(blockPosition.z) + 0.5,
  });
}
