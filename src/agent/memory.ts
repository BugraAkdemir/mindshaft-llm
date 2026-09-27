import type { AgentConfig } from '../config/config.js';
import type { ActionRecord, AgentEvent, ToolErrorCode, WorldState } from '../types.js';
import { formatPoint, type Point3 } from '../utils/spatial.js';
import { tagged, type Logger } from '../utils/logger.js';

export interface KnownLocation {
  kind: string;
  position: Point3;
  notedAt: number;
}

export interface MemorySnapshot {
  recentActions: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    result: 'success' | 'failure';
    error?: ToolErrorCode;
    details?: string;
  }>;
  recentEvents: string[];
  importantFacts: string[];
  knownLocations: string[];
  consecutiveFailures: number;
  repeatedFailure: string | null;
}

/**
 * Bounded short-term memory.
 *
 * The point is not to remember everything — it is to remember the few things
 * that stop the agent from rediscovering the same information every cycle, while
 * keeping the prompt small. Every collection here is explicitly capped.
 */
export class MemoryManager {
  private readonly cfg: AgentConfig;
  private readonly log: Logger;

  private actions: ActionRecord[] = [];
  private events: AgentEvent[] = [];
  private facts: string[] = [];
  private locations = new Map<string, KnownLocation>();
  private consecutiveFailures = 0;
  private lastObservation: WorldState | null = null;
  /** Counts identical failing calls so the prompt can call out a loop. */
  private failureSignatures = new Map<string, number>();

  public constructor(cfg: AgentConfig, logger?: Logger) {
    this.cfg = cfg;
    this.log = tagged('MEMORY', logger);
  }

  /* ──────────────────────────────── actions ───────────────────────────── */

  public recordAction(record: ActionRecord): void {
    this.actions.push(record);
    if (this.actions.length > this.cfg.memoryActionHistory) {
      this.actions = this.actions.slice(-this.cfg.memoryActionHistory);
    }

    if (record.success) {
      this.consecutiveFailures = 0;
      this.failureSignatures.clear();
    } else {
      this.consecutiveFailures += 1;
      const signature = `${record.tool}:${record.error ?? 'unknown'}:${stableStringify(record.arguments)}`;
      this.failureSignatures.set(signature, (this.failureSignatures.get(signature) ?? 0) + 1);
    }
  }

  public get failureStreak(): number {
    return this.consecutiveFailures;
  }

  public resetFailureStreak(): void {
    this.consecutiveFailures = 0;
    this.failureSignatures.clear();
  }

  /**
   * Describes a call the agent has failed at repeatedly, so the prompt can tell
   * the model to stop trying it. Returns null until it has happened 3 times.
   */
  public repeatedFailure(): string | null {
    let worst: { signature: string; count: number } | null = null;
    for (const [signature, count] of this.failureSignatures) {
      if (count >= 3 && (!worst || count > worst.count)) worst = { signature, count };
    }
    if (!worst) return null;
    const [tool, error] = worst.signature.split(':');
    return `You have tried "${tool}" and got ${error} ${worst.count} times in a row. That approach is not working — try something different.`;
  }

  public lastAction(): ActionRecord | null {
    return this.actions.at(-1) ?? null;
  }

  /* ──────────────────────────────── events ───────────────────────────── */

  public recordEvent(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > this.cfg.memoryEventHistory) {
      this.events = this.events.slice(-this.cfg.memoryEventHistory);
    }
  }

  /** Drains the event buffer, keeping critical entries for one more cycle. */
  public takeEvents(): AgentEvent[] {
    const drained = this.events;
    this.events = drained.filter((event) => event.severity === 'critical').slice(-3);
    return drained;
  }

  /* ───────────────────────────────── facts ───────────────────────────── */

  /**
   * Stores a durable observation. Facts are deduplicated case-insensitively so
   * the model repeating itself does not fill the budget.
   */
  public remember(fact: string): void {
    const trimmed = fact.trim();
    if (trimmed.length < 4) return;

    const normalized = trimmed.toLowerCase();
    if (this.facts.some((existing) => existing.toLowerCase() === normalized)) return;

    this.facts.push(trimmed.slice(0, 200));
    if (this.facts.length > this.cfg.memoryMaxFacts) {
      // Drop the oldest, keeping the memory relevant to recent play.
      this.facts = this.facts.slice(-this.cfg.memoryMaxFacts);
    }
    this.log.debug(`remembered: ${trimmed.slice(0, 80)}`);
  }

  public forgetAll(): void {
    this.facts = [];
    this.locations.clear();
  }

  /* ─────────────────────────────── locations ─────────────────────────── */

  /**
   * Records where a useful structure is. Keyed by kind so revisiting a crafting
   * table updates the position rather than accumulating duplicates.
   */
  public noteLocation(kind: string, position: Point3): void {
    this.locations.set(kind, { kind, position, notedAt: Date.now() });
    // Keep the map small; the oldest entries are the least likely to matter.
    if (this.locations.size > 12) {
      const oldest = [...this.locations.values()].sort((a, b) => a.notedAt - b.notedAt)[0];
      if (oldest) this.locations.delete(oldest.kind);
    }
  }

  public getLocation(kind: string): KnownLocation | undefined {
    return this.locations.get(kind);
  }

  /**
   * Harvests durable facts out of an observation: where the crafting table and
   * furnace are, and which ores have been spotted.
   */
  public learnFromObservation(state: WorldState): void {
    this.lastObservation = state;

    for (const group of state.nearbyBlocks) {
      if (TRACKED_STRUCTURES.has(group.type)) {
        this.noteLocation(group.type, group.nearest);
      }
      if (group.type.endsWith('_ore') || group.type === 'ancient_debris') {
        this.remember(
          `Saw ${group.type} (x${group.count}) near ${formatPoint(group.nearest)} at y=${group.nearest.y}.`,
        );
      }
    }
  }

  public latestObservation(): WorldState | null {
    return this.lastObservation;
  }

  /* ─────────────────────────────── snapshot ──────────────────────────── */

  public snapshot(): MemorySnapshot {
    return {
      recentActions: this.actions.map((action) => ({
        tool: action.tool,
        arguments: action.arguments,
        result: action.success ? 'success' : 'failure',
        ...(action.error ? { error: action.error } : {}),
        ...(action.details ? { details: truncate(action.details, 160) } : {}),
      })),
      recentEvents: this.events.map((event) => event.message),
      importantFacts: [...this.facts],
      knownLocations: [...this.locations.values()].map(
        (location) => `${location.kind} at ${formatPoint(location.position)}`,
      ),
      consecutiveFailures: this.consecutiveFailures,
      repeatedFailure: this.repeatedFailure(),
    };
  }
}

const TRACKED_STRUCTURES = new Set([
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'chest',
  'barrel',
  'anvil',
  'enchanting_table',
  'brewing_stand',
  'bed',
  'white_bed',
  'red_bed',
]);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Deterministic JSON for comparing two tool calls. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
