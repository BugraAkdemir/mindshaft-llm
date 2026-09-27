import { describe, expect, it } from 'vitest';
import { MemoryManager, stableStringify } from '../src/agent/memory.js';
import type { ActionRecord } from '../src/types.js';
import { emptyWorldState, testConfig } from './helpers/fixtures.js';

function action(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    tool: 'move_to',
    arguments: { x: 1, y: 64, z: 1 },
    reason: 'walking',
    success: true,
    durationMs: 100,
    at: Date.now(),
    ...overrides,
  };
}

describe('action history trimming', () => {
  it('keeps only the most recent N actions', () => {
    const memory = new MemoryManager(testConfig({ MEMORY_ACTION_HISTORY: '3' }).agent);
    for (let i = 0; i < 10; i += 1) {
      memory.recordAction(action({ arguments: { step: i } }));
    }

    const recent = memory.snapshot().recentActions;
    expect(recent).toHaveLength(3);
    expect(recent.map((entry) => entry.arguments['step'])).toEqual([7, 8, 9]);
  });

  it('exposes the most recent action', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.recordAction(action({ tool: 'mine' }));
    expect(memory.lastAction()?.tool).toBe('mine');
  });

  it('records failures with their error code and truncated details', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.recordAction(
      action({ success: false, error: 'PATH_NOT_FOUND', details: 'x'.repeat(400) }),
    );

    const entry = memory.snapshot().recentActions[0]!;
    expect(entry.result).toBe('failure');
    expect(entry.error).toBe('PATH_NOT_FOUND');
    expect(entry.details!.length).toBeLessThanOrEqual(160);
    expect(entry.details!.endsWith('…')).toBe(true);
  });
});

describe('failure streak tracking', () => {
  it('counts consecutive failures and resets on success', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.recordAction(action({ success: false, error: 'PATH_NOT_FOUND' }));
    memory.recordAction(action({ success: false, error: 'PATH_NOT_FOUND' }));
    expect(memory.failureStreak).toBe(2);

    memory.recordAction(action({ success: true }));
    expect(memory.failureStreak).toBe(0);
  });

  it('detects an identical failing call repeated three times', () => {
    const memory = new MemoryManager(testConfig().agent);
    const failing = action({ success: false, error: 'BLOCK_NOT_FOUND', arguments: { block: 'diamond_ore' } });

    memory.recordAction(failing);
    memory.recordAction(failing);
    expect(memory.repeatedFailure()).toBeNull();

    memory.recordAction(failing);
    const warning = memory.repeatedFailure();
    expect(warning).toContain('BLOCK_NOT_FOUND');
    expect(warning).toContain('3 times');
  });

  it('does not conflate different arguments as the same failure', () => {
    const memory = new MemoryManager(testConfig().agent);
    for (const block of ['iron_ore', 'coal_ore', 'gold_ore']) {
      memory.recordAction(action({ success: false, error: 'BLOCK_NOT_FOUND', arguments: { block } }));
    }
    expect(memory.repeatedFailure()).toBeNull();
  });

  it('clears the streak explicitly', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.recordAction(action({ success: false, error: 'TIMEOUT' }));
    memory.resetFailureStreak();
    expect(memory.failureStreak).toBe(0);
    expect(memory.repeatedFailure()).toBeNull();
  });
});

describe('event buffer', () => {
  it('trims to the configured size', () => {
    const memory = new MemoryManager(testConfig({ MEMORY_EVENT_HISTORY: '4' }).agent);
    for (let i = 0; i < 12; i += 1) {
      memory.recordEvent({ message: `event ${i}`, severity: 'info', at: Date.now() });
    }
    expect(memory.snapshot().recentEvents).toHaveLength(4);
  });

  it('drains events but carries critical ones into the next cycle', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.recordEvent({ message: 'picked up wood', severity: 'info', at: Date.now() });
    memory.recordEvent({ message: 'HEALTH CRITICAL', severity: 'critical', at: Date.now() });

    const drained = memory.takeEvents();
    expect(drained).toHaveLength(2);

    const remaining = memory.snapshot().recentEvents;
    expect(remaining).toEqual(['HEALTH CRITICAL']);
  });
});

describe('durable facts', () => {
  it('deduplicates case-insensitively', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.remember('Found an oak forest north-east.');
    memory.remember('found an OAK FOREST north-east.');
    expect(memory.snapshot().importantFacts).toHaveLength(1);
  });

  it('ignores trivially short facts', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.remember('ok');
    memory.remember('');
    expect(memory.snapshot().importantFacts).toHaveLength(0);
  });

  it('caps the fact list, dropping the oldest', () => {
    const memory = new MemoryManager(testConfig({ MEMORY_MAX_FACTS: '3' }).agent);
    for (let i = 0; i < 8; i += 1) memory.remember(`fact number ${i}`);

    const facts = memory.snapshot().importantFacts;
    expect(facts).toHaveLength(3);
    expect(facts).toEqual(['fact number 5', 'fact number 6', 'fact number 7']);
  });

  it('truncates a very long fact', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.remember('y'.repeat(500));
    expect(memory.snapshot().importantFacts[0]!.length).toBe(200);
  });
});

describe('known locations', () => {
  it('stores one entry per kind and updates it in place', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.noteLocation('crafting_table', { x: 10, y: 64, z: 10 });
    memory.noteLocation('crafting_table', { x: 20, y: 64, z: 20 });

    expect(memory.getLocation('crafting_table')?.position).toEqual({ x: 20, y: 64, z: 20 });
    expect(memory.snapshot().knownLocations).toEqual(['crafting_table at 20,64,20']);
  });

  it('evicts the oldest entry past the cap', () => {
    const memory = new MemoryManager(testConfig().agent);
    for (let i = 0; i < 15; i += 1) memory.noteLocation(`kind_${i}`, { x: i, y: 64, z: 0 });
    expect(memory.snapshot().knownLocations.length).toBeLessThanOrEqual(12);
    expect(memory.getLocation('kind_0')).toBeUndefined();
  });

  it('learns workstation locations and ore sightings from an observation', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.learnFromObservation(
      emptyWorldState({
        nearbyBlocks: [
          {
            type: 'crafting_table',
            count: 1,
            nearest: { x: 120, y: 64, z: -40 },
            distance: 5,
            direction: 'north',
            relative: { x: 0, y: 0, z: -5 },
          },
          {
            type: 'iron_ore',
            count: 4,
            nearest: { x: 8, y: 12, z: 3 },
            distance: 9,
            direction: 'east',
            relative: { x: 8, y: -52, z: 3 },
          },
        ],
      }),
    );

    expect(memory.getLocation('crafting_table')?.position).toEqual({ x: 120, y: 64, z: -40 });
    const facts = memory.snapshot().importantFacts;
    expect(facts.some((fact) => fact.includes('iron_ore') && fact.includes('y=12'))).toBe(true);
  });

  it('forgets everything on request', () => {
    const memory = new MemoryManager(testConfig().agent);
    memory.remember('something notable happened here');
    memory.noteLocation('furnace', { x: 0, y: 64, z: 0 });
    memory.forgetAll();

    const snapshot = memory.snapshot();
    expect(snapshot.importantFacts).toHaveLength(0);
    expect(snapshot.knownLocations).toHaveLength(0);
  });
});

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('handles nesting, arrays and primitives', () => {
    expect(stableStringify({ a: [1, { c: 3, b: 2 }] })).toBe('{"a":[1,{"b":2,"c":3}]}');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('x')).toBe('"x"');
  });

  it('ignores undefined values', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
