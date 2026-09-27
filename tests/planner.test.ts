import { describe, expect, it } from 'vitest';
import { analyseGoal, GoalManager } from '../src/agent/planner.js';
import { emptyWorldState } from './helpers/fixtures.js';

describe('goal parsing', () => {
  it('extracts a concrete tool target', () => {
    const hint = analyseGoal('Get enough iron to craft an iron pickaxe');
    expect(hint.targetItems).toContain('iron_pickaxe');
    expect(hint.openEnded).toBe(false);
  });

  it('maps bare material words to real item names', () => {
    expect(analyseGoal('Find gold').targetItems).toContain('gold_ingot');
    expect(analyseGoal('Gather wood').targetItems).toContain('oak_log');
  });

  it('recognises underscored and spaced item names alike', () => {
    expect(analyseGoal('craft a diamond_pickaxe').targetItems).toContain('diamond_pickaxe');
    expect(analyseGoal('craft a diamond pickaxe').targetItems).toContain('diamond_pickaxe');
  });

  it('flags open-ended goals', () => {
    expect(analyseGoal('Explore the world').openEnded).toBe(true);
    expect(analyseGoal('Survive the night').openEnded).toBe(true);
    expect(analyseGoal('Keep gathering resources').openEnded).toBe(true);
    expect(analyseGoal('Build a small house').openEnded).toBe(false);
  });

  it('returns no targets for a goal naming nothing concrete', () => {
    expect(analyseGoal('Build a small house').targetItems).toHaveLength(0);
  });

  it('deduplicates overlapping matches', () => {
    const hint = analyseGoal('get iron and an iron pickaxe and more iron');
    expect(new Set(hint.targetItems).size).toBe(hint.targetItems.length);
  });
});

describe('GoalManager lifecycle', () => {
  it('tracks cycles and the model-stated focus', () => {
    const goals = new GoalManager('Get an iron pickaxe');
    goals.beginCycle('gathering wood first');
    goals.beginCycle('now mining stone');

    const snapshot = goals.snapshot();
    expect(snapshot.cycles).toBe(2);
    expect(snapshot.currentFocus).toBe('now mining stone');
  });

  it('records deduplicated milestones with a cap', () => {
    const goals = new GoalManager('Get an iron pickaxe');
    goals.addMilestone('Have 3x oak_log.');
    goals.addMilestone('Have 3x oak_log.');
    expect(goals.snapshot().milestones).toHaveLength(1);

    for (let i = 0; i < 30; i += 1) goals.addMilestone(`milestone ${i}`);
    expect(goals.snapshot().milestones.length).toBeLessThanOrEqual(20);
  });

  it('derives milestones from inventory progress toward the target', () => {
    const goals = new GoalManager('Get an iron pickaxe');
    goals.observeProgress(emptyWorldState({ inventoryCounts: { iron_pickaxe: 1 } }));
    expect(goals.snapshot().milestones.some((entry) => entry.includes('iron_pickaxe'))).toBe(true);
  });

  it('resets fully when the goal is replaced', () => {
    const goals = new GoalManager('Get an iron pickaxe');
    goals.beginCycle('working');
    goals.addMilestone('something');
    goals.setGoal('Explore the world');

    const snapshot = goals.snapshot();
    expect(snapshot.goal).toBe('Explore the world');
    expect(snapshot.cycles).toBe(0);
    expect(snapshot.milestones).toHaveLength(0);
    expect(goals.hints.openEnded).toBe(true);
  });
});

describe('completion verification', () => {
  it('rejects a completion claim when the named item is absent', () => {
    const goals = new GoalManager('Get an iron pickaxe');
    const verdict = goals.tryComplete('I think I am done', emptyWorldState());

    expect(verdict.accepted).toBe(false);
    expect(verdict.explanation).toContain('iron_pickaxe');
    expect(goals.isComplete).toBe(false);
  });

  it('accepts a completion claim once the item is in the inventory', () => {
    const goals = new GoalManager('Get an iron pickaxe');
    const verdict = goals.tryComplete(
      'crafted it',
      emptyWorldState({ inventoryCounts: { iron_pickaxe: 1 } }),
    );

    expect(verdict.accepted).toBe(true);
    expect(goals.isComplete).toBe(true);
    expect(goals.snapshot().completionReason).toBe('crafted it');
    expect(goals.snapshot().completedAt).toBeTypeOf('number');
  });

  it('never auto-completes an open-ended goal', () => {
    const goals = new GoalManager('Explore the world');
    const verdict = goals.tryComplete('explored enough', emptyWorldState());

    expect(verdict.accepted).toBe(false);
    expect(verdict.explanation).toContain('open-ended');
  });

  it('accepts an open-ended goal that still names a concrete item', () => {
    const goals = new GoalManager('Survive and obtain iron');
    expect(goals.hints.targetItems).toContain('iron_ingot');
    const verdict = goals.tryComplete('got the iron', emptyWorldState({ inventoryCounts: { iron_ingot: 5 } }));
    expect(verdict.accepted).toBe(true);
  });

  it('accepts a goal with no detectable target on the model\'s word', () => {
    const goals = new GoalManager('Build a small house');
    expect(goals.tryComplete('house built', emptyWorldState()).accepted).toBe(true);
  });

  it('is idempotent once complete', () => {
    const goals = new GoalManager('Build a small house');
    goals.tryComplete('done', emptyWorldState());
    expect(goals.tryComplete('done again', emptyWorldState()).accepted).toBe(true);
  });
});

describe('prompt rendering', () => {
  it('includes the goal, targets and progress', () => {
    const goals = new GoalManager('Get enough iron to craft an iron pickaxe');
    goals.beginCycle('mining stone');
    goals.addMilestone('Have 20x cobblestone.');

    const text = goals.describeForPrompt();
    expect(text).toContain('GOAL: Get enough iron');
    expect(text).toContain('iron_pickaxe');
    expect(text).toContain('mining stone');
    expect(text).toContain('Have 20x cobblestone.');
  });

  it('warns that an open-ended goal has no finish line', () => {
    expect(new GoalManager('Explore the world').describeForPrompt()).toContain('open-ended');
  });
});
