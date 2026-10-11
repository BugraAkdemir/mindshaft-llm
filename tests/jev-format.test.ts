import { describe, expect, it } from 'vitest';
import { formatReason, formatRemember, nearestGroup, nearestOf } from '../src/llm/jev-format.js';
import type { BlockGroup, EntityInfo } from '../src/types.js';

const answers = {
  tool: 'mine',
  toolProbabilities: { mine: 0.42, observe: 0.21, move_to: 0.14 },
  toolConfidence: 0.55,
  target: 'oak_log',
  urgency: 'tense',
  goalComplete: false,
  rememberWorth: true,
} as const;

describe('formatReason', () => {
  it('names the tool, the probability and the runner-up distribution', () => {
    const reason = formatReason(answers);
    expect(reason).toContain('mine');
    expect(reason).toContain('oak_log');
    expect(reason).toContain('p=0.42');
    expect(reason).toContain('observe 0.21');
    expect(reason).toContain('urgency=tense');
  });

  it('omits the target when none was offered', () => {
    expect(formatReason({ ...answers, target: undefined })).not.toContain('undefined');
  });

  it('keeps the reason inside the 600 character contract', () => {
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`tool_${i}`, i / 100]));
    expect(formatReason({ ...answers, toolProbabilities: many }).length).toBeLessThanOrEqual(600);
  });

  it('survives a winner missing from its own probability map', () => {
    expect(formatReason({ ...answers, toolProbabilities: {} })).toContain('p=0');
  });
});

describe('formatRemember', () => {
  it('records the goal and the current action', () => {
    const note = formatRemember('Gather wood', answers);
    expect(note).toContain('Gather wood');
    expect(note).toContain('mine');
    expect(note).toContain('oak_log');
  });

  it('stays inside the 240 character contract', () => {
    expect(formatRemember('x'.repeat(1000), answers).length).toBeLessThanOrEqual(240);
  });
});

describe('lookups', () => {
  const group = (type: string, distance: number): BlockGroup =>
    ({ type, count: 1, nearest: { x: 0, y: 0, z: 0 }, distance, direction: 'north', relative: { x: 0, y: 0, z: 0 } }) as BlockGroup;

  const entity = (id: number, category: EntityInfo['category'], distance: number): EntityInfo =>
    ({ id, type: 'x', name: 'x', category, position: { x: 0, y: 0, z: 0 }, distance, direction: 'north', relative: { x: 0, y: 0, z: 0 } }) as EntityInfo;

  it('finds the closest group of a type', () => {
    expect(nearestGroup([group('stone', 5), group('oak_log', 2), group('oak_log', 9)], 'oak_log')?.distance).toBe(2);
    expect(nearestGroup([group('stone', 5)], 'oak_log')).toBeUndefined();
  });

  it('finds the closest entity of a category', () => {
    expect(nearestOf([entity(1, 'passive', 3), entity(2, 'hostile', 7)], 'hostile')?.id).toBe(2);
    expect(nearestOf([entity(1, 'passive', 3)], 'hostile')).toBeUndefined();
  });
});