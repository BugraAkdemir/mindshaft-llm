import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractToolCalls,
  flattenContent,
  looksLikeJsonModeUnsupported,
  looksLikeToolsUnsupported,
  OpenRouterProvider,
} from '../src/llm/openrouter.js';
import { LlmError, type LlmRequest } from '../src/llm/provider.js';
import { scrubSecrets } from '../src/utils/logger.js';
import { testConfig } from './helpers/fixtures.js';

function llmConfig(overrides: Partial<ReturnType<typeof testConfig>['llm']> = {}) {
  return { ...testConfig().llm, maxRetries: 0, requestTimeoutMs: 2_000, ...overrides };
}

function request(mode: 'tools' | 'json' = 'json'): LlmRequest {
  return {
    mode,
    messages: [{ role: 'user', content: 'hello' }],
    ...(mode === 'tools'
      ? { tools: [{ name: 'observe', description: 'look', parameters: { type: 'object', properties: {} } }] }
      : {}),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function chatCompletion(message: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return {
    id: 'gen-1',
    model: 'respan/span-01-lite:free',
    choices: [{ message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wire-format normalisation', () => {
  it('flattens string content', () => {
    expect(flattenContent('hello')).toBe('hello');
  });

  it('flattens content-parts arrays', () => {
    expect(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
  });

  it('returns null for absent or empty content', () => {
    expect(flattenContent(null)).toBeNull();
    expect(flattenContent(undefined)).toBeNull();
    expect(flattenContent([])).toBeNull();
  });

  it('extracts tool calls and fills in a missing id', () => {
    const calls = extractToolCalls([
      { id: 'c1', function: { name: 'move_to', arguments: '{"x":1}' } },
      { function: { name: 'observe' } },
    ]);

    expect(calls).toEqual([
      { id: 'c1', name: 'move_to', arguments: '{"x":1}' },
      { id: 'call_1', name: 'observe', arguments: '{}' },
    ]);
  });

  it('skips tool calls with no function name', () => {
    expect(extractToolCalls([{ id: 'c1' }])).toEqual([]);
    expect(extractToolCalls(undefined)).toEqual([]);
  });

  it('recognises provider messages about missing tool support', () => {
    expect(looksLikeToolsUnsupported('No endpoints found that support tool use')).toBe(true);
    expect(looksLikeToolsUnsupported('This model does not support tools')).toBe(true);
    expect(looksLikeToolsUnsupported('rate limit exceeded')).toBe(false);
  });

  it('recognises provider messages about missing JSON mode', () => {
    expect(looksLikeJsonModeUnsupported('response_format is not supported')).toBe(true);
    expect(looksLikeJsonModeUnsupported('all good')).toBe(false);
  });
});

describe('OpenRouter request format', () => {
  it('posts an OpenAI-compatible chat completion with auth and attribution headers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(chatCompletion({ role: 'assistant', content: '{"tool":"observe"}' })));

    const provider = new OpenRouterProvider(
      llmConfig({ siteUrl: 'https://example.com', appName: 'my-agent' }),
    );
    const response = await provider.complete(request('json'));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-test-key-not-real');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Title']).toBe('my-agent');
    expect(headers['HTTP-Referer']).toBe('https://example.com');

    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['model']).toBe('respan/span-01-lite:free');
    expect(body['stream']).toBe(false);
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }]);
    // JSON mode asks the provider to enforce a JSON object.
    expect(body['response_format']).toEqual({ type: 'json_object' });
    expect(body['tools']).toBeUndefined();

    expect(response.content).toBe('{"tool":"observe"}');
    expect(response.usage?.totalTokens).toBe(120);
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends function-style tool specs in tools mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        chatCompletion({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'observe', arguments: '{}' } }],
        }),
      ),
    );

    const provider = new OpenRouterProvider(llmConfig({ mode: 'tools' }));
    const response = await provider.complete(request('tools'));

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body['tool_choice']).toBe('required');
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: { name: 'observe', description: 'look', parameters: { type: 'object', properties: {} } },
      },
    ]);
    expect(body['response_format']).toBeUndefined();

    expect(response.toolCalls).toEqual([{ id: 'c1', name: 'observe', arguments: '{}' }]);
  });

  it('serialises assistant tool_calls and tool results when replaying a correction', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(chatCompletion({ role: 'assistant', content: '{}' })));

    const provider = new OpenRouterProvider(llmConfig());
    await provider.complete({
      mode: 'json',
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 'c1', name: 'observe', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'observe', content: '{"success":false}' },
      ],
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages[1]!['tool_calls']).toEqual([
      { id: 'c1', type: 'function', function: { name: 'observe', arguments: '{}' } },
    ]);
    expect(body.messages[2]!['tool_call_id']).toBe('c1');
  });
});

describe('OpenRouter error handling', () => {
  it('classifies 401 as a non-retryable auth error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'No auth credentials found' } }, 401),
    );

    const provider = new OpenRouterProvider(llmConfig({ maxRetries: 2 }));
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'AUTH', retryable: false });
  });

  it('retries a 429 and succeeds on a later attempt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Rate limit exceeded' } }, 429))
      .mockResolvedValueOnce(jsonResponse(chatCompletion({ role: 'assistant', content: '{"tool":"wait"}' })));

    const provider = new OpenRouterProvider(llmConfig({ maxRetries: 1 }));
    const response = await provider.complete(request());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.content).toBe('{"tool":"wait"}');
  }, 15_000);

  it('gives up after exhausting retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 500));

    const provider = new OpenRouterProvider(llmConfig({ maxRetries: 1 }));
    await expect(provider.complete(request())).rejects.toBeInstanceOf(LlmError);
  }, 15_000);

  it('treats a 200 response carrying an error envelope as a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'upstream provider is down' } }),
    );

    const provider = new OpenRouterProvider(llmConfig());
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'SERVER' });
  });

  it('rejects a response with no choices', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ model: 'x', choices: [] }));

    const provider = new OpenRouterProvider(llmConfig());
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects a non-JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 200 }));

    const provider = new OpenRouterProvider(llmConfig());
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('reports a network failure as retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const provider = new OpenRouterProvider(llmConfig());
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });

  it('times out a hanging request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const provider = new OpenRouterProvider(llmConfig({ requestTimeoutMs: 150 }));
    await expect(provider.complete(request())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('honours an external abort signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);

    const provider = new OpenRouterProvider(llmConfig({ requestTimeoutMs: 10_000 }));
    await expect(provider.complete({ ...request(), signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });
});

describe('capability fallback', () => {
  it('permanently disables tool calling when the provider rejects tools', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'No endpoints found that support tool use.' } }, 404),
      )
      .mockResolvedValue(jsonResponse(chatCompletion({ role: 'assistant', content: '{"tool":"observe"}' })));

    const provider = new OpenRouterProvider(llmConfig({ mode: 'auto', maxRetries: 1 }));
    expect(provider.supportsToolCalling()).toBe(true);

    const response = await provider.complete(request('tools'));

    expect(provider.supportsToolCalling()).toBe(false);
    expect(response.content).toBe('{"tool":"observe"}');

    // The retry no longer advertises tools, and falls back to JSON mode.
    const retryBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(retryBody['tools']).toBeUndefined();
    expect(retryBody['response_format']).toEqual({ type: 'json_object' });
  }, 15_000);

  it('starts with tool calling disabled when mode is json', () => {
    expect(new OpenRouterProvider(llmConfig({ mode: 'json' })).supportsToolCalling()).toBe(false);
  });

  it('stops sending response_format when the model rejects it', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'response_format is not supported by this model' } }, 400),
      )
      .mockResolvedValue(jsonResponse(chatCompletion({ role: 'assistant', content: '{"tool":"observe"}' })));

    const provider = new OpenRouterProvider(llmConfig({ mode: 'json', maxRetries: 1 }));
    await provider.complete(request('json'));

    const retryBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(retryBody['response_format']).toBeUndefined();
  }, 15_000);
});

describe('secret redaction', () => {
  it('scrubs OpenRouter keys and bearer tokens from free text', () => {
    expect(scrubSecrets('key sk-or-v1-abcdef123456 leaked')).toContain('sk-or-v1-[redacted]');
    expect(scrubSecrets('Authorization: Bearer abc.def-ghi')).toContain('Bearer [redacted]');
  });

  it('never includes the API key in an error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'bad key: sk-or-v1-supersecretvalue' } }, 401),
    );

    const provider = new OpenRouterProvider(llmConfig());
    await expect(provider.complete(request())).rejects.toSatisfy(
      (err: unknown) => err instanceof Error && !err.message.includes('supersecretvalue'),
    );
  });
});
