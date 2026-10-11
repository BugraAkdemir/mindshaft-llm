import { describe, expect, it } from 'vitest';
import { buildPayload, buildState, candidateTargets } from '../src/llm/jev-questions.js';
import type { LlmRequest } from '../src/llm/provider.js';
import type { BlockGroup, WorldState } from '../src/types.js';

function group(type: string, distance: number, count = 1): BlockGroup {
  return {
    type,
    count,
    nearest: { x: 0, y: 0, z: 0 },
    distance,
    direction: 'north',
    relative: { x: 0, y: 0, z: 0 },
  } as BlockGroup;
}

const groups = [group('oak_log', 3, 12), group('stone', 8, 90), group('dirt', 6, 40)];

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    messages: [
      { role: 'system', content: 'SYSTEM RULES' },
      { role: 'user', content: 'HP 20, dusk, oak_log nearby' },
    ],
    mode: 'json',
    tools: [
      { name: 'mine', description: 'Break a block.', parameters: {} },
      { name: 'observe', description: 'Look around.', parameters: {} },
    ],
    observation: { nearbyBlocks: groups } as unknown as WorldState,
    ...overrides,
  };
}

describe('buildPayload', () => {
  it('offers every tool as a choice criterion', () => {
    const payload = buildPayload(makeRequest());
    expect(Object.keys(payload.questions['tool']!.criteria as Record<string, string>)).toEqual([
      'mine',
      'observe',
    ]);
  });

  it('carries the tool descriptions so the criteria mean something', () => {
    const criteria = buildPayload(makeRequest()).questions['tool']!.criteria as Record<string, string>;
    expect(criteria['mine']).toBe('Break a block.');
  });

  it('asks for choice, score and noul questions', () => {
    const q = buildPayload(makeRequest()).questions;
    expect(q['tool']!.type).toBe('choice');
    expect(q['target']!.type).toBe('choice');
    expect(q['urgency']!.type).toBe('score');
    expect(q['goal_complete']!.type).toBe('noul');
    expect(q['remember_worth']!.type).toBe('noul');
  });

  it('scores urgency against a three step rubric', () => {
    expect(buildPayload(makeRequest()).questions['urgency']!.criteria).toEqual([
      'calm',
      'tense',
      'critical',
    ]);
  });

  it('carries the configured model id', () => {
    expect(buildPayload(makeRequest(), 'jev-1.13-free').model).toBe('jev-1.13-free');
  });

  it('describes each target by how many are in reach', () => {
    const criteria = buildPayload(makeRequest()).questions['target']!.criteria as Record<string, string>;
    expect(criteria['oak_log']).toBe('12');
  });

  it('omits the target question when nothing is nearby', () => {
    const request = makeRequest({
      observation: { nearbyBlocks: [] } as unknown as WorldState,
    });
    expect(buildPayload(request).questions['target']).toBeUndefined();
  });

  it('copes with no tool specs at all', () => {
    const request = makeRequest({ tools: undefined });
    expect(buildPayload(request).questions['tool']!.criteria).toEqual({});
  });

  it('copes with no observation at all', () => {
    const request = makeRequest({ observation: undefined });
    const payload = buildPayload(request);
    expect(payload.questions['target']).toBeUndefined();
    expect(payload.state).toContain('SYSTEM RULES');
  });
});

describe('buildState', () => {
  it('includes the system prompt and the latest situation', () => {
    const state = buildState(makeRequest());
    expect(state).toContain('SYSTEM RULES');
    expect(state).toContain('HP 20, dusk, oak_log nearby');
  });

  it('uses only the newest user message, not the stale ones', () => {
    const request = makeRequest({
      messages: [
        { role: 'system', content: 'RULES' },
        { role: 'user', content: 'OLD: the world was on fire' },
        { role: 'user', content: 'NEW: it is raining now' },
      ],
    });
    const state = buildState(request);
    expect(state).toContain('NEW: it is raining now');
    expect(state).not.toContain('the world was on fire');
  });
});

describe('candidateTargets', () => {
  it('sorts by proximity', () => {
    expect(candidateTargets({ nearbyBlocks: groups } as unknown as WorldState)).toEqual([
      'oak_log',
      'dirt',
      'stone',
    ]);
  });

  it('caps the list at eight entries', () => {
    const many = Array.from({ length: 30 }, (_, i) => group(`block_${i}`, i));
    expect(
      candidateTargets({ nearbyBlocks: many } as unknown as WorldState),
    ).toHaveLength(8);
  });

  it('returns an empty list with no observation', () => {
    expect(candidateTargets(undefined)).toEqual([]);
  });
});