import type { z } from 'zod';
import type { Bot } from 'mineflayer';
import type { AgentConfig } from '../config/config.js';
import type { BlockActions } from '../minecraft/blocks.js';
import type { CombatController } from '../minecraft/combat.js';
import type { CraftingManager } from '../minecraft/crafting.js';
import type { InventoryManager } from '../minecraft/inventory.js';
import type { MovementController } from '../minecraft/movement.js';
import type { WorldObserver } from '../minecraft/observer.js';
import type { GameRegistry } from '../minecraft/registry.js';
import type { LlmToolSpec } from '../llm/provider.js';
import { fail, type ToolResult } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';
import { formatZodIssues, toToolJsonSchema } from './schemas.js';

/** Everything a tool is allowed to touch. Tools never import Mineflayer plugins directly. */
export interface ToolContext {
  bot: Bot;
  registry: GameRegistry;
  observer: WorldObserver;
  movement: MovementController;
  inventory: InventoryManager;
  combat: CombatController;
  blocks: BlockActions;
  crafting: CraftingManager;
  cfg: AgentConfig;
  log: Logger;
  /** Aborted by the reactive safety layer when an emergency pre-empts the action. */
  signal: AbortSignal;
  /** Deadline for this specific execution, already clamped to the global limit. */
  timeoutMs: number;
}

/**
 * A registered tool with its argument type erased.
 *
 * `invoke` is only ever called by `ToolRegistry.execute` with data that has
 * already passed `schema`, which is what makes the erasure safe.
 */
export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  /** Default execution budget in ms; clamped by `MAX_ACTION_TIMEOUT_MS`. */
  timeoutMs: number;
  invoke: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
  /** Cleanup invoked when the deadline fires, so the bot is not left mid-action. */
  onTimeout?: (ctx: ToolContext) => void;
}

export interface ToolDefinition<TSchema extends z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  timeoutMs: number;
  execute: (args: z.output<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
  onTimeout?: (ctx: ToolContext) => void;
}

/**
 * Declares a tool, keeping full type inference from the Zod schema inside
 * `execute` while producing the erased `Tool` the registry stores.
 */
export function defineTool<TSchema extends z.ZodType>(definition: ToolDefinition<TSchema>): Tool {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    timeoutMs: definition.timeoutMs,
    invoke: (args, ctx) => definition.execute(args as z.output<TSchema>, ctx),
    ...(definition.onTimeout ? { onTimeout: definition.onTimeout } : {}),
  };
}

/**
 * The single gate between model output and the game.
 *
 * Model output is untrusted input: every call is looked up by name, its
 * arguments are validated against a Zod schema, its runtime is capped, and any
 * thrown error becomes a structured failure. There is no code-execution path —
 * the model can only name a tool that was registered here.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly log: Logger;
  private specCache: LlmToolSpec[] | null = null;

  public constructor(logger?: Logger) {
    this.log = tagged('TOOL', logger);
  }

  public register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
    this.specCache = null;
  }

  public registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public names(): string[] {
    return [...this.tools.keys()].sort();
  }

  public size(): number {
    return this.tools.size;
  }

  /** Tool specs for native tool calling. */
  public specs(): LlmToolSpec[] {
    if (this.specCache) return this.specCache;
    this.specCache = [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toToolJsonSchema(tool.schema),
    }));
    return this.specCache;
  }

  /** Compact textual catalogue used in JSON mode, where there is no tool API. */
  public describeForPrompt(): string {
    const lines: string[] = [];
    for (const tool of this.tools.values()) {
      const schema = toToolJsonSchema(tool.schema);
      const properties = (schema['properties'] ?? {}) as Record<string, { type?: string; description?: string; enum?: unknown[] }>;
      const required = new Set((schema['required'] as string[] | undefined) ?? []);

      const params = Object.entries(properties).map(([key, value]) => {
        const type = Array.isArray(value.enum) ? value.enum.map(String).join('|') : (value.type ?? 'any');
        return `${key}${required.has(key) ? '' : '?'}: ${type}`;
      });

      lines.push(`- ${tool.name}(${params.join(', ')})`);
      lines.push(`    ${tool.description}`);
      for (const [key, value] of Object.entries(properties)) {
        if (value.description) lines.push(`    · ${key}: ${value.description}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Validates and runs a tool. Never throws: every outcome, including an
   * unknown tool name or a blown deadline, comes back as a `ToolResult`.
   */
  public async execute(
    name: string,
    rawArgs: unknown,
    context: Omit<ToolContext, 'timeoutMs'>,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);

    if (!tool) {
      return fail(
        'UNKNOWN_TOOL',
        `"${name}" is not an available tool. Available tools: ${this.names().join(', ')}.`,
        Date.now() - startedAt,
      );
    }

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return fail(
        'INVALID_ARGUMENTS',
        `Arguments for "${name}" are invalid — ${formatZodIssues(parsed.error)}.`,
        Date.now() - startedAt,
      );
    }

    const timeoutMs = Math.min(tool.timeoutMs, context.cfg.maxActionTimeoutMs);
    const ctx: ToolContext = { ...context, timeoutMs };

    if (ctx.signal.aborted) {
      return fail('ABORTED', 'Action cancelled before it started (safety interrupt).', Date.now() - startedAt);
    }

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ToolResult>((resolve) => {
      deadlineTimer = setTimeout(() => {
        try {
          tool.onTimeout?.(ctx);
        } catch (err) {
          this.log.debug({ err }, `onTimeout for ${name} threw (ignored)`);
        }
        resolve(
          fail(
            'TIMEOUT',
            `Tool "${name}" exceeded its ${timeoutMs}ms budget and was cancelled.`,
            Date.now() - startedAt,
          ),
        );
      }, timeoutMs);
    });

    try {
      const execution = tool
        .invoke(parsed.data, ctx)
        .catch((err: unknown) =>
          fail(
            'MINEFLAYER_ERROR',
            `Tool "${name}" threw: ${err instanceof Error ? err.message : String(err)}`,
            Date.now() - startedAt,
          ),
        );

      const result = await Promise.race([execution, deadline]);
      // Stamp the real duration; individual modules only measure their own part.
      return { ...result, durationMs: result.durationMs || Date.now() - startedAt };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }
}
