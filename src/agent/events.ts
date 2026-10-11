import type { InventoryEntry } from '../types.js';
import type { Point3 } from '../utils/spatial.js';

/**
 * What the control panel observes.
 *
 * Named `AgentStreamEvent` because `AgentEvent` in `src/types.ts` already means
 * "something that happened in the world", which is a different thing.
 */
export type AgentStreamEvent =
  | {
      type: 'lifecycle';
      status: 'connecting' | 'connected' | 'disconnected' | 'stopped';
      detail?: string;
    }
  | {
      type: 'world';
      cycle: number;
      health: number;
      food: number;
      pos: Point3;
      timeOfDay: string;
      isDay: boolean;
      inventory: InventoryEntry[];
    }
  | {
      type: 'decision';
      cycle: number;
      tool: string;
      arguments: Record<string, unknown>;
      reason: string;
    }
  | {
      type: 'result';
      cycle: number;
      success: boolean;
      error?: string;
      details?: string;
      durationMs: number;
    }
  | { type: 'cycle'; cycle: number; kind: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'critical'; message: string };

export type EventListener = (event: AgentStreamEvent) => void;

/**
 * A minimal synchronous emitter.
 *
 * A dependency would be heavier than the twenty lines it replaces, and a
 * listener that throws — a browser connection that just went away — must never
 * take the run down with it.
 */
export class EventBus {
  private listeners = new Set<EventListener>();

  public on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public get size(): number {
    return this.listeners.size;
  }

  public emit(event: AgentStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        // stdout belongs to the panel protocol, so this goes to stderr too.
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`agent event listener failed: ${detail}\n`);
      }
    }
  }
}