import { scrubSecrets, tagged, type Logger } from '../utils/logger.js';
import type { LlmConfig } from '../config/config.js';
import {
  LlmError,
  type LLMProvider,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
} from './provider.js';

/* ── Shapes of the OpenAI-compatible wire format we actually rely on. ──── */

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role?: string;
  content?: string | null | Array<{ type?: string; text?: string }>;
  tool_calls?: WireToolCall[];
  reasoning?: string | null;
}

interface WireChoice {
  message?: WireMessage;
  finish_reason?: string | null;
}

interface WireResponse {
  id?: string;
  model?: string;
  choices?: WireChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: number | string; metadata?: unknown };
}

/** Error substrings that mean "this model has no tool-calling endpoint". */
const TOOLS_UNSUPPORTED_HINTS = [
  'no endpoints found that support tool use',
  'does not support tools',
  'tool use is not supported',
  'tool_choice is not supported',
  'function calling is not supported',
  'tools is not supported',
];

/**
 * Some models ignore `response_format` entirely and a few reject it outright.
 * When that happens we stop sending it and lean on the prompt instead — the
 * parser is tolerant enough to recover JSON from prose.
 */
const JSON_MODE_UNSUPPORTED_HINTS = [
  'response_format',
  'json_object is not supported',
  'json mode is not supported',
];

export class OpenRouterProvider implements LLMProvider {
  public readonly name = 'openrouter';
  public readonly model: string;

  private readonly log: Logger;
  private readonly cfg: LlmConfig;
  private toolCallingSupported: boolean;
  private jsonModeSupported = true;

  public constructor(cfg: LlmConfig, logger?: Logger) {
    this.cfg = cfg;
    this.model = cfg.model;
    this.log = tagged('LLM', logger);
    // Optimistic until an API response proves otherwise.
    this.toolCallingSupported = cfg.mode !== 'json';
  }

  public supportsToolCalling(): boolean {
    return this.toolCallingSupported;
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    const attempts = this.cfg.maxRetries + 1;
    let lastError: LlmError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.once(request);
      } catch (err) {
        const error = err instanceof LlmError ? err : this.wrap(err);
        lastError = error;

        if (!error.retryable || attempt === attempts) throw error;

        // Exponential backoff with jitter; rate limits get a longer floor.
        const base = error.code === 'RATE_LIMIT' ? 2_000 : 500;
        const delay = Math.min(base * 2 ** (attempt - 1), 15_000) + Math.random() * 250;
        this.log.warn(
          { attempt, of: attempts, code: error.code, delayMs: Math.round(delay) },
          `request failed (${error.message}); retrying`,
        );
        await sleep(delay, request.signal);
      }
    }

    /* c8 ignore next — the loop above always returns or throws. */
    throw lastError ?? new LlmError('LLM request failed', 'NETWORK', false);
  }

  private async once(request: LlmRequest): Promise<LlmResponse> {
    const useTools = request.mode === 'tools' && this.toolCallingSupported && !!request.tools?.length;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toWireMessage),
      temperature: request.temperature ?? this.cfg.temperature,
      max_tokens: request.maxTokens ?? this.cfg.maxTokens,
      stream: false,
    };

    if (useTools) {
      body['tools'] = request.tools!.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body['tool_choice'] = 'required';
    } else if (this.jsonModeSupported) {
      body['response_format'] = { type: 'json_object' };
    }

    // Combine the caller's abort signal with our own request timeout.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.cfg.requestTimeoutMs);
    const signals: AbortSignal[] = [timeoutController.signal];
    if (request.signal) signals.push(request.signal);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (timeoutController.signal.aborted) {
        throw new LlmError(`request timed out after ${this.cfg.requestTimeoutMs}ms`, 'TIMEOUT', true);
      }
      if (request.signal?.aborted) {
        throw new LlmError('request aborted', 'ABORTED', false);
      }
      throw this.wrap(err);
    }
    clearTimeout(timer);

    const text = await response.text();

    if (!response.ok) {
      throw this.httpError(response.status, text, useTools);
    }

    let parsed: WireResponse;
    try {
      parsed = JSON.parse(text) as WireResponse;
    } catch {
      throw new LlmError(
        `response was not valid JSON: ${scrubSecrets(text.slice(0, 300))}`,
        'BAD_RESPONSE',
        true,
      );
    }

    // OpenRouter can return HTTP 200 with an error envelope.
    if (parsed.error) {
      const message = parsed.error.message ?? 'unknown provider error';
      if (useTools && looksLikeToolsUnsupported(message)) {
        this.disableToolCalling(message);
        throw new LlmError(message, 'TOOLS_UNSUPPORTED', true);
      }
      throw new LlmError(scrubSecrets(message), 'SERVER', true);
    }

    const choice = parsed.choices?.[0];
    if (!choice?.message) {
      throw new LlmError('response contained no choices', 'BAD_RESPONSE', true);
    }

    return {
      content: flattenContent(choice.message.content),
      toolCalls: extractToolCalls(choice.message.tool_calls),
      model: parsed.model ?? this.model,
      finishReason: choice.finish_reason ?? null,
      usage: {
        promptTokens: parsed.usage?.prompt_tokens,
        completionTokens: parsed.usage?.completion_tokens,
        totalTokens: parsed.usage?.total_tokens,
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': this.cfg.appName,
    };
    if (this.cfg.siteUrl) headers['HTTP-Referer'] = this.cfg.siteUrl;
    return headers;
  }

  private httpError(status: number, rawBody: string, usedTools: boolean): LlmError {
    let message = rawBody.slice(0, 400);
    try {
      const parsed = JSON.parse(rawBody) as WireResponse;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* keep the raw snippet */
    }
    message = scrubSecrets(message);

    if (usedTools && looksLikeToolsUnsupported(message)) {
      this.disableToolCalling(message);
      return new LlmError(message, 'TOOLS_UNSUPPORTED', true);
    }
    if (this.jsonModeSupported && !usedTools && looksLikeJsonModeUnsupported(message)) {
      this.jsonModeSupported = false;
      this.log.warn('model rejected response_format; falling back to prompt-enforced JSON');
      return new LlmError(message, 'BAD_RESPONSE', true);
    }

    if (status === 401 || status === 403) {
      return new LlmError(`authentication failed (${status}): ${message}`, 'AUTH', false, status);
    }
    if (status === 429) {
      return new LlmError(`rate limited: ${message}`, 'RATE_LIMIT', true, status);
    }
    if (status === 400 || status === 404 || status === 422) {
      return new LlmError(`request rejected (${status}): ${message}`, 'BAD_RESPONSE', false, status);
    }
    return new LlmError(`provider error (${status}): ${message}`, 'SERVER', status >= 500, status);
  }

  private disableToolCalling(reason: string): void {
    if (!this.toolCallingSupported) return;
    this.toolCallingSupported = false;
    this.log.warn(
      { reason: scrubSecrets(reason).slice(0, 200) },
      `model "${this.model}" does not support native tool calling; switching to strict JSON mode`,
    );
  }

  private wrap(err: unknown): LlmError {
    if (err instanceof LlmError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'AbortError') {
      return new LlmError('request aborted', 'ABORTED', false);
    }
    return new LlmError(`network error: ${scrubSecrets(message)}`, 'NETWORK', true);
  }
}

/* ────────────────────────────── wire helpers ──────────────────────────── */

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name) wire['name'] = message.name;
  if (message.toolCallId) wire['tool_call_id'] = message.toolCallId;
  if (message.toolCalls?.length) {
    wire['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return wire;
}

/** Normalises both the plain-string and the content-parts array forms. */
export function flattenContent(content: WireMessage['content']): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  const text = content
    .filter((part) => part?.type === undefined || part.type === 'text')
    .map((part) => part?.text ?? '')
    .join('')
    .trim();
  return text === '' ? null : text;
}

export function extractToolCalls(raw: WireToolCall[] | undefined): LlmToolCall[] {
  if (!raw?.length) return [];
  const calls: LlmToolCall[] = [];
  for (const [index, call] of raw.entries()) {
    const name = call.function?.name;
    if (!name) continue;
    calls.push({
      id: call.id ?? `call_${index}`,
      name,
      arguments: call.function?.arguments ?? '{}',
    });
  }
  return calls;
}

export function looksLikeToolsUnsupported(message: string): boolean {
  const lower = message.toLowerCase();
  return TOOLS_UNSUPPORTED_HINTS.some((hint) => lower.includes(hint));
}

export function looksLikeJsonModeUnsupported(message: string): boolean {
  const lower = message.toLowerCase();
  return JSON_MODE_UNSUPPORTED_HINTS.some((hint) => lower.includes(hint));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('aborted while backing off', 'ABORTED', false));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new LlmError('aborted while backing off', 'ABORTED', false));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
