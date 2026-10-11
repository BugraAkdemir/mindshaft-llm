import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevProvider } from '../src/llm/jev.js';
import { LlmError, type LlmRequest } from '../src/llm/provider.js';
import type { JevConfig } from '../src/config/config.js';
import { testConfig } from './helpers/fixtures.js';
import type { WorldState } from '../src/types.js';

function jevConfig(overrides: Partial<JevConfig> = {}): JevConfig {
  return { ...testConfig().jev, maxRetries: 0, requestTimeoutMs: 2_000, ...overrides };
}

const observation = {
  nearbyBlocks: [
    {
      type: 'oak_log',
      count: 12,
      nearest: { x: 11, y: 64, z: 18 },
      distance: 3,
      direction: 'north',
      relative: { x: 1, y: 0, z: -2 },
    },
  ],
  entities: [],
  threats: [],
  inventory: [],
  inventoryCounts: {},
} as unknown as WorldState;

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    messages: [
      { role: 'system', content: 'You are a Minecraft agent. Reply with one JSON object.' },
      { role: 'user', content: '## Goal\nGOAL: Gather wood\n\n## Situation\nHP 20, dusk.' },
    ],
    mode: 'json',
    tools: [
      { name: 'mine', description: 'Break a block.', parameters: {} },
      { name: 'observe', description: 'Look around.', parameters: {} },
    ],
    observation,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ANSWER = {
  model: 'jev-1.13-free',
  answers: {
    tool: { type: 'choice', choice: 'mine', probabilities: { mine: 0.7, observe: 0.3 }, confidence: 0.8 },
    target: { type: 'choice', choice: 'oak_log', probabilities: { oak_log: 0.9 }, confidence: 0.9 },
    urgency: { type: 'score', score: 'tense', probabilities: { calm: 0.2, tense: 0.7, critical: 0.1 }, confidence: 0.7 },
    goal_complete: { type: 'noul', noul: 0.02 },
    remember_worth: { type: 'noul', noul: 0.9 },
  },
};

/** Runs `promise` to completion without needing real timers to advance. */
async function settle<T>(promise: Promise<T>): Promise<T | LlmError> {
  return promise.catch((err: LlmError) => err);
}

describe('JevProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports no native tool calling', () => {
    expect(new JevProvider(jevConfig()).supportsToolCalling()).toBe(false);
  });

  it('posts to /systemone with the configured model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ANSWER));
    vi.stubGlobal('fetch', fetchMock);

    await new JevProvider(jevConfig()).complete(makeRequest());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/zen/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-or-v1-test-key-not-real');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('jev-1.13-free');
    expect(body.questions.tool.type).toBe('choice');
    expect(body.state).toContain('GOAL: Gather wood');
  });

  it('returns exactly one tool call built from the answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ANSWER)));

    const response = await new JevProvider(jevConfig()).complete(makeRequest());

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.name).toBe('mine');
    expect(JSON.parse(response.toolCalls[0]!.arguments)).toMatchObject({
      block: 'oak_log',
      count: 4,
      collect: true,
    });
    expect(response.content).toContain('p=0.7');
    expect(response.content).toContain('oak_log');
  });

  it('carries the templated memory note when the model wants one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ANSWER)));

    const response = await new JevProvider(jevConfig()).complete(makeRequest());
    const decision = JSON.parse(response.content!);
    expect(decision.remember).toContain('Gather wood');
    expect(decision.remember).toContain('mine oak_log');
  });

  it('marks the goal complete above the noul threshold', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...ANSWER,
          answers: { ...ANSWER.answers, goal_complete: { type: 'noul', noul: 0.91 } },
        }),
      ),
    );

    const response = await new JevProvider(jevConfig()).complete(makeRequest());
    expect(JSON.parse(response.content!).goal_complete).toBe(true);
  });

  it('leaves the goal incomplete below the threshold', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ANSWER)));
    const response = await new JevProvider(jevConfig()).complete(makeRequest());
    expect(JSON.parse(response.content!).goal_complete).toBe(false);
  });

  it('still acts when confidence is low, but says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...ANSWER,
          answers: {
            ...ANSWER.answers,
            tool: { type: 'choice', choice: 'mine', probabilities: { mine: 0.08, observe: 0.9 }, confidence: 0.08 },
          },
        }),
      ),
    );

    const response = await new JevProvider(jevConfig({ confidenceThreshold: 0.25 })).complete(makeRequest());
    expect(response.toolCalls).toHaveLength(1);
    expect(response.content).toContain('low confidence (p=0.08)');
  });

  it('says nothing about confidence when the winner is decisive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ANSWER)));
    const response = await new JevProvider(jevConfig({ confidenceThreshold: 0.25 })).complete(makeRequest());
    expect(response.content).not.toContain('low confidence');
  });

  it('falls back to calm when the urgency answer is unusable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ ...ANSWER, answers: { ...ANSWER.answers, urgency: { type: 'score' } } }),
      ),
    );

    const response = await new JevProvider(jevConfig()).complete(makeRequest());
    expect(JSON.parse(response.toolCalls[0]!.arguments).count).toBe(3);
  });

  it('fails loudly when the tool answer is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ model: 'jev-1.13-free', answers: {} })),
    );

    const error = await settle(new JevProvider(jevConfig()).complete(makeRequest()));
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe('BAD_RESPONSE');
  });

  it('does not retry a 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const error = await settle(new JevProvider(jevConfig()).complete(makeRequest()));
    expect((error as LlmError).code).toBe('AUTH');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 the configured number of times', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'slow down' } }, 429));
    vi.stubGlobal('fetch', fetchMock);

    const settled = settle(new JevProvider(jevConfig({ maxRetries: 2 })).complete(makeRequest()));
    await vi.runAllTimersAsync();
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await settled) as LlmError).toBeDefined();
  });

  it('retries a 500 and succeeds on the second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'upstream' } }, 500))
      .mockResolvedValueOnce(jsonResponse(ANSWER));
    vi.stubGlobal('fetch', fetchMock);

    const settled = settle(
      new JevProvider(jevConfig({ maxRetries: 1 })).complete(makeRequest()),
    );
    await vi.runAllTimersAsync();
    const response = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response).toHaveProperty('toolCalls');
  });

  it('reports a timeout as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );

    const settled = settle(
      new JevProvider(jevConfig({ maxRetries: 0, requestTimeoutMs: 1_000 })).complete(makeRequest()),
    );
    await vi.advanceTimersByTimeAsync(1_100);
    expect(((await settled) as LlmError).code).toBe('TIMEOUT');
  });

  it('rejects a body that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html>gateway</html>',
      } as unknown as Response),
    );

    const error = await settle(new JevProvider(jevConfig()).complete(makeRequest()));
    expect((error as LlmError).code).toBe('BAD_RESPONSE');
  });

  it('scrubs the key out of error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'invalid key zen-abc123' } }, 403)),
    );

    const error = await settle(
      new JevProvider(jevConfig({ apiKey: 'zen-abc123' })).complete(makeRequest()),
    );
    expect((error as LlmError).message).not.toContain('zen-abc123');
  });
});