import { describe, expect, it } from 'vitest';
import {
  decisionFromToolCall,
  extractJsonObject,
  normalizeDecisionShape,
  parseDecisionFromText,
  stripCodeFences,
  validateDecision,
} from '../src/llm/parser.js';

describe('extractJsonObject', () => {
  it('extracts a bare object', () => {
    expect(extractJsonObject('{"tool":"observe"}')).toBe('{"tool":"observe"}');
  });

  it('extracts an object wrapped in a json code fence', () => {
    const text = 'Sure!\n```json\n{"tool":"mine","arguments":{"block":"oak_log"}}\n```\nHope that helps.';
    expect(extractJsonObject(text)).toBe('{"tool":"mine","arguments":{"block":"oak_log"}}');
  });

  it('extracts an object preceded and followed by prose', () => {
    const text = 'I will move there. {"tool":"move_to","arguments":{"x":1,"y":2,"z":3}} That is my plan.';
    expect(extractJsonObject(text)).toBe('{"tool":"move_to","arguments":{"x":1,"y":2,"z":3}}');
  });

  it('handles nested objects', () => {
    const text = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('is not fooled by braces inside strings', () => {
    const text = '{"reason":"it looks like {this}","tool":"wait"}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"reason":"he said \\"hi\\" to me","tool":"wait"}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('returns null when there is no balanced object', () => {
    expect(extractJsonObject('no json at all')).toBeNull();
    expect(extractJsonObject('{"unclosed": true')).toBeNull();
  });

  it('skips an unbalanced object and finds a later valid one', () => {
    expect(extractJsonObject('{ broken ["}"] {"tool":"wait","arguments":{}}')).toContain('"tool":"wait"');
  });

  it('strips fences without a language tag', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe('normalizeDecisionShape', () => {
  it('accepts the canonical shape', () => {
    expect(normalizeDecisionShape({ tool: 'observe', arguments: {}, reason: 'look around' })).toEqual({
      tool: 'observe',
      arguments: {},
      reason: 'look around',
    });
  });

  it('maps common aliases onto the canonical keys', () => {
    const normalized = normalizeDecisionShape({
      name: 'MOVE_TO',
      parameters: { x: 1, y: 2, z: 3 },
      thought: 'heading north',
    });
    expect(normalized).toEqual({ tool: 'move_to', arguments: { x: 1, y: 2, z: 3 }, reason: 'heading north' });
  });

  it('unwraps an OpenAI-style function envelope', () => {
    const normalized = normalizeDecisionShape({
      function: { name: 'mine', arguments: { block: 'stone' } },
    });
    expect(normalized).toEqual({ tool: 'mine', arguments: { block: 'stone' } });
  });

  it('parses arguments that arrive as a JSON string', () => {
    const normalized = normalizeDecisionShape({ tool: 'wait', args: '{"seconds":2}' });
    expect(normalized?.['arguments']).toEqual({ seconds: 2 });
  });

  it('falls back to an empty object for unparseable argument strings', () => {
    expect(normalizeDecisionShape({ tool: 'wait', args: 'not json' })?.['arguments']).toEqual({});
    expect(normalizeDecisionShape({ tool: 'wait', args: '[1,2]' })?.['arguments']).toEqual({});
  });

  it('rejects arrays and primitives', () => {
    expect(normalizeDecisionShape([1, 2, 3])).toBeNull();
    expect(normalizeDecisionShape('hello')).toBeNull();
    expect(normalizeDecisionShape(null)).toBeNull();
  });
});

describe('parseDecisionFromText — malformed LLM responses', () => {
  it('parses a valid decision', () => {
    const outcome = parseDecisionFromText('{"reason":"wood nearby","tool":"mine","arguments":{"block":"oak_log"}}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.tool).toBe('mine');
    expect(outcome.decision.arguments).toEqual({ block: 'oak_log' });
    expect(outcome.decision.reason).toBe('wood nearby');
  });

  it('defaults a missing reason and missing arguments', () => {
    const outcome = parseDecisionFromText('{"tool":"observe"}');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.reason).toBe('');
    expect(outcome.decision.arguments).toEqual({});
  });

  it('reports EMPTY_RESPONSE for null and blank content', () => {
    expect(parseDecisionFromText(null)).toMatchObject({ ok: false, code: 'EMPTY_RESPONSE' });
    expect(parseDecisionFromText('   ')).toMatchObject({ ok: false, code: 'EMPTY_RESPONSE' });
  });

  it('reports NO_JSON_FOUND for pure prose', () => {
    const outcome = parseDecisionFromText('I think I should go mine some wood over there.');
    expect(outcome).toMatchObject({ ok: false, code: 'NO_JSON_FOUND' });
    if (outcome.ok) return;
    expect(outcome.message).toContain('JSON object');
  });

  it('reports INVALID_JSON for syntactically broken JSON', () => {
    const outcome = parseDecisionFromText('{"tool": "observe", }');
    expect(outcome).toMatchObject({ ok: false, code: 'INVALID_JSON' });
  });

  it('reports SCHEMA_MISMATCH for a missing tool name', () => {
    const outcome = parseDecisionFromText('{"reason":"thinking"}');
    expect(outcome).toMatchObject({ ok: false, code: 'SCHEMA_MISMATCH' });
    if (outcome.ok) return;
    expect(outcome.message).toContain('tool');
  });

  it('rejects a tool name that is not lower_snake_case', () => {
    const outcome = parseDecisionFromText('{"tool":"Move-To","arguments":{}}');
    expect(outcome).toMatchObject({ ok: false, code: 'SCHEMA_MISMATCH' });
  });

  it('recovers the object when the model wraps it in an array', () => {
    const outcome = parseDecisionFromText('[{"tool":"observe","arguments":{}}]');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.tool).toBe('observe');
  });

  it('rejects a decoded array at the validation layer', () => {
    expect(validateDecision([{ tool: 'observe' }])).toMatchObject({
      ok: false,
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('carries through remember and goal_complete', () => {
    const outcome = parseDecisionFromText(
      '{"tool":"observe","arguments":{},"remember":"iron at y=-16","goal_complete":true}',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.remember).toBe('iron at y=-16');
    expect(outcome.decision.goalComplete).toBe(true);
  });

  it('truncation guard: rejects an over-long reason', () => {
    const outcome = validateDecision({ tool: 'observe', reason: 'x'.repeat(700) });
    expect(outcome).toMatchObject({ ok: false, code: 'SCHEMA_MISMATCH' });
  });
});

describe('decisionFromToolCall', () => {
  it('builds a decision from a native tool call', () => {
    const outcome = decisionFromToolCall('move_to', '{"x":1,"y":2,"z":3}', 'walking over');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision).toMatchObject({
      tool: 'move_to',
      arguments: { x: 1, y: 2, z: 3 },
      reason: 'walking over',
    });
  });

  it('treats empty arguments as an empty object', () => {
    const outcome = decisionFromToolCall('observe', '', null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.arguments).toEqual({});
  });

  it('recovers arguments embedded in surrounding text', () => {
    const outcome = decisionFromToolCall('wait', 'here you go: {"seconds": 3}', null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.arguments).toEqual({ seconds: 3 });
  });

  it('fails cleanly when the arguments are not JSON at all', () => {
    expect(decisionFromToolCall('wait', 'three seconds please', null)).toMatchObject({
      ok: false,
      code: 'INVALID_JSON',
    });
  });

  it('lifts a reason smuggled into the arguments', () => {
    const outcome = decisionFromToolCall('observe', '{"reasoning":"checking surroundings"}', null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.decision.reason).toBe('checking surroundings');
  });
});
