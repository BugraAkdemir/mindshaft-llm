import type { WorldState } from '../types.js';
import { tagged, type Logger } from '../utils/logger.js';

export interface GoalProgress {
  goal: string;
  cycles: number;
  complete: boolean;
  completedAt: number | null;
  completionReason: string | null;
  /** Free-text milestones the agent has reported along the way. */
  milestones: string[];
  /** The model's own description of what it is currently working on. */
  currentFocus: string | null;
}

/**
 * Detected "obvious" goal targets, used only to double-check a completion claim
 * and to note milestones. Plans themselves are always derived by the model.
 */
export interface GoalHint {
  /** Item names the goal text explicitly asks for. */
  targetItems: string[];
  /** Whether the goal is open-ended (explore, survive) with no terminal state. */
  openEnded: boolean;
}

const OPEN_ENDED_PATTERNS = [/\bexplore\b/i, /\bsurvive\b/i, /\bwander\b/i, /\bforever\b/i, /\bkeep\b/i];

/** Item words worth recognising in a goal string, longest match first. */
const KNOWN_TARGETS = [
  'enchanted_golden_apple',
  'netherite_pickaxe',
  'netherite_ingot',
  'diamond_pickaxe',
  'diamond_sword',
  'iron_pickaxe',
  'iron_sword',
  'stone_pickaxe',
  'wooden_pickaxe',
  'crafting_table',
  'iron_ingot',
  'gold_ingot',
  'ancient_debris',
  'diamond',
  'emerald',
  'redstone',
  'obsidian',
  'furnace',
  'shield',
  'bucket',
  'torch',
  'bread',
  'wheat',
  'coal',
  'iron',
  'gold',
  'wood',
  'bed',
];

/**
 * Tracks the natural-language goal and how far the agent has got.
 *
 * Deliberately *not* a hardcoded tech tree: the model derives its own plan each
 * cycle. This class only holds the goal, counts cycles, records milestones the
 * model reports, and applies a light sanity check before accepting that the goal
 * is done — so "I am finished" without the item in inventory is rejected.
 */
export class GoalManager {
  private readonly log: Logger;
  private progress: GoalProgress;
  private hint: GoalHint;

  public constructor(goal: string, logger?: Logger) {
    this.log = tagged('GOAL', logger);
    this.progress = {
      goal: goal.trim(),
      cycles: 0,
      complete: false,
      completedAt: null,
      completionReason: null,
      milestones: [],
      currentFocus: null,
    };
    this.hint = analyseGoal(goal);
    this.log.info(
      { targets: this.hint.targetItems, openEnded: this.hint.openEnded },
      `goal set: ${this.progress.goal}`,
    );
  }

  public get goal(): string {
    return this.progress.goal;
  }

  public get isComplete(): boolean {
    return this.progress.complete;
  }

  public get hints(): GoalHint {
    return this.hint;
  }

  public snapshot(): GoalProgress {
    return { ...this.progress, milestones: [...this.progress.milestones] };
  }

  public setGoal(goal: string): void {
    this.progress = {
      goal: goal.trim(),
      cycles: 0,
      complete: false,
      completedAt: null,
      completionReason: null,
      milestones: [],
      currentFocus: null,
    };
    this.hint = analyseGoal(goal);
    this.log.info(`goal changed: ${this.progress.goal}`);
  }

  public beginCycle(focus: string | null): void {
    this.progress.cycles += 1;
    if (focus && focus.trim() !== '') {
      this.progress.currentFocus = focus.trim().slice(0, 200);
    }
  }

  public addMilestone(text: string): void {
    const trimmed = text.trim().slice(0, 160);
    if (trimmed === '' || this.progress.milestones.includes(trimmed)) return;
    this.progress.milestones.push(trimmed);
    if (this.progress.milestones.length > 20) {
      this.progress.milestones = this.progress.milestones.slice(-20);
    }
    this.log.info(`milestone: ${trimmed}`);
  }

  /**
   * Notes progress toward any target item the goal named. Called after every
   * successful action so the model gets credit for real, verifiable progress.
   */
  public observeProgress(state: WorldState): void {
    for (const target of this.hint.targetItems) {
      const count = state.inventoryCounts[target] ?? 0;
      if (count > 0) this.addMilestone(`Have ${count}x ${target}.`);
    }
  }

  /**
   * Accepts or rejects the model's claim that the goal is finished.
   *
   * When the goal names concrete items, the claim is only honoured if those
   * items are actually in the inventory — otherwise the agent would happily
   * declare victory on turn two. Open-ended goals are never auto-completed.
   */
  public tryComplete(reason: string, state: WorldState): { accepted: boolean; explanation: string } {
    if (this.progress.complete) {
      return { accepted: true, explanation: 'Goal was already complete.' };
    }

    if (this.hint.openEnded && this.hint.targetItems.length === 0) {
      return {
        accepted: false,
        explanation:
          'This goal is open-ended (exploring/surviving), so it has no finish line. Keep going — ' +
          'report interesting discoveries with the "remember" field instead.',
      };
    }

    const missing = this.hint.targetItems.filter((item) => (state.inventoryCounts[item] ?? 0) === 0);
    if (this.hint.targetItems.length > 0 && missing.length > 0) {
      return {
        accepted: false,
        explanation:
          `Not complete yet: the goal mentions ${missing.join(', ')}, and your inventory contains none. ` +
          'Keep working toward it.',
      };
    }

    this.progress.complete = true;
    this.progress.completedAt = Date.now();
    this.progress.completionReason = reason.slice(0, 300);
    this.log.info(`goal complete: ${reason.slice(0, 160)}`);
    return { accepted: true, explanation: 'Goal marked complete.' };
  }

  /** Short block describing goal state for the prompt. */
  public describeForPrompt(): string {
    const lines = [`GOAL: ${this.progress.goal}`, `Decision cycles so far: ${this.progress.cycles}`];
    if (this.hint.targetItems.length > 0) {
      lines.push(`Concrete targets detected in the goal: ${this.hint.targetItems.join(', ')}`);
    }
    if (this.hint.openEnded) {
      lines.push('This goal is open-ended — there is no finish line, so keep making progress.');
    }
    if (this.progress.currentFocus) {
      lines.push(`Your last stated focus: ${this.progress.currentFocus}`);
    }
    if (this.progress.milestones.length > 0) {
      lines.push(`Progress so far: ${this.progress.milestones.slice(-6).join(' | ')}`);
    }
    return lines.join('\n');
  }
}

/** Extracts concrete item targets and open-endedness from a goal string. */
export function analyseGoal(goal: string): GoalHint {
  const normalized = goal.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ');
  const compact = normalized.replace(/\s+/g, '_');

  const targetItems: string[] = [];
  for (const candidate of KNOWN_TARGETS) {
    // Match both "iron pickaxe" and "iron_pickaxe" forms.
    const spaced = candidate.replace(/_/g, ' ');
    if (compact.includes(candidate) || normalized.includes(spaced)) {
      // Skip a broad word when a more specific target already covered it.
      if (targetItems.some((existing) => existing.includes(candidate))) continue;
      targetItems.push(candidate);
    }
  }

  // "iron" alone is not a real item name; map the bare materials to their ingots.
  const mapped = targetItems.map((item) => MATERIAL_ALIASES[item] ?? item);
  const unique = [...new Set(mapped)];

  return {
    targetItems: unique,
    openEnded: OPEN_ENDED_PATTERNS.some((pattern) => pattern.test(goal)),
  };
}

const MATERIAL_ALIASES: Record<string, string> = {
  iron: 'iron_ingot',
  gold: 'gold_ingot',
  wood: 'oak_log',
  bed: 'white_bed',
};
