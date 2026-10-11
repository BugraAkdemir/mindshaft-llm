import { scrubSecrets, tagged, type Logger } from '../utils/logger.js';
import type { JevConfig } from '../config/config.js';
import { LlmError, type LLMProvider, type LlmRequest, type LlmResponse } from './provider.js';
import { buildPayload } from './jev-questions.js';
import { buildArguments } from './jev-args.js';
import { formatReason, formatRemember, type JevAnswers } from './jev-format.js';

export type { JevAnswers } from './jev-format.js';

/* ─────────────────────────── wire shapes ───────────────────────────────── */

interface WireAnswer {
  type?: string;
  choice?: string;
  score?: string;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface WireResponse {
  model?: string;
  answers?: Record<string, WireAnswer>;
  error?: { message?: string };
}

const NOUL_THRESHOLD = 0.5;
const REMEMBER_THRESHOLD = 0.6;
const URGENCY_RUBRIC = ['calm', 'tense', 'critical'] as const;

/**
 * OpenCode Zen's Jev, a "System One" model.
 *
 * It is not a chat model: there is no text generation, no tool calling and no
 * `response_format`. One request carries the turn's state plus every question
 * at once, and one response carries typed answers with probabilities. The tool
 * name comes from the model; its arguments come from `jev-args.ts`, because a
 * decision model cannot produce them.
 */
export class JevProvider implements LLMProvider {
  public readonly name = 'jev';
  public readonly model: string;

  private readonly log: Logger;
  private readonly cfg: JevConfig;

  public constructor(cfg: JevConfig, logger?: Logger) {
    this.cfg = cfg;
    this.model = cfg.model;
    this.log = tagged('LLM', logger);
  }

  /** Jev has no tool-calling endpoint; it answers typed questions instead. */
  public supportsToolCalling(): false {
    return false;
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

        // Jev is deterministic for a given state, so retrying the identical
        // payload is meaningful rather than a coin flip.
        const base = error.code === 'RATE_LIMIT' ? 2_000 : 500;
        const delay = Math.min(base * 2 ** (attempt - 1), 15_000) + Math.random() * 250;
        this.log.warn(
          { attempt, of: attempts, code: error.code },
          `jev request failed (${error.message}); retrying`,
        );
        await sleep(delay, request.signal);
      }
    }

    /* c8 ignore next — the loop above always returns or throws. */
    throw lastError ?? new LlmError('Jev request failed', 'NETWORK', false);
  }

  private async once(request: LlmRequest): Promise<LlmResponse> {
    const payload = buildPayload(request, this.cfg.model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.cfg.baseUrl}/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new LlmError(`request timed out after ${this.cfg.requestTimeoutMs}ms`, 'TIMEOUT', true);
      }
      throw this.wrap(err);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) throw this.httpError(response.status, text);

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
    // Zen can answer 200 with an error envelope.
    if (parsed.error?.message) throw this.httpError(500, JSON.stringify(parsed));

    const answers = this.readAnswers(parsed);
    const args = buildArguments(answers, request.observation);
    const confidence = answers.toolProbabilities[answers.tool] ?? 0;

    const decision: Record<string, unknown> = {
      reason: formatReason(answers),
      tool: answers.tool,
      arguments: args,
      goal_complete: answers.goalComplete,
    };
    if (answers.rememberWorth) {
      decision['remember'] = formatRemember(goalFromPrompt(request), answers);
    }

    this.log.debug(
      { tool: answers.tool, confidence: answers.toolConfidence },
      'jev decision accepted',
    );

    return {
      content: JSON.stringify(decision),
      toolCalls: [{ id: 'jev_0', name: answers.tool, arguments: JSON.stringify(args) }],
      model: parsed.model ?? this.model,
      finishReason: 'stop',
      latencyMs: Date.now() - startedAt,
      ...(confidence < this.cfg.confidenceThreshold
        ? { content: `${JSON.stringify(decision)}\n\nlow confidence (p=${confidence.toFixed(2)})` }
        : {}),
    };
  }

  private readAnswers(parsed: WireResponse): JevAnswers {
    const answers = parsed.answers ?? {};
    const tool = answers['tool'];
    if (!tool?.choice) {
      throw new LlmError('jev response contained no tool answer', 'BAD_RESPONSE', true);
    }

    const scored = answers['urgency']?.score;
    const urgency =
      scored !== undefined && URGENCY_RUBRIC.includes(scored as (typeof URGENCY_RUBRIC)[number])
        ? (scored as (typeof URGENCY_RUBRIC)[number])
        : 'calm';

    return {
      tool: tool.choice,
      toolProbabilities: tool.probabilities ?? { [tool.choice]: 1 },
      toolConfidence: tool.confidence ?? 1,
      target: answers['target']?.choice,
      urgency,
      goalComplete: (answers['goal_complete']?.noul ?? 0) > NOUL_THRESHOLD,
      rememberWorth: (answers['remember_worth']?.noul ?? 0) > REMEMBER_THRESHOLD,
    };
  }

  private httpError(status: number, rawBody: string): LlmError {
    let message = rawBody.slice(0, 400);
    try {
      const parsed = JSON.parse(rawBody) as WireResponse;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* keep the raw snippet */
    }
    message = this.scrub(message);

    if (status === 401 || status === 403) {
      return new LlmError(`authentication failed (${status}): ${message}`, 'AUTH', false, status);
    }
    if (status === 429) {
      return new LlmError(`rate limited: ${message}`, 'RATE_LIMIT', true, status);
    }
    if (status === 400 || status === 404 || status === 422) {
      return new LlmError(`request rejected (${status}): ${message}`, 'BAD_RESPONSE', false, status);
    }
    return new LlmError(`jev error (${status}): ${message}`, 'SERVER', status >= 500, status);
  }

  /**
   * `scrubSecrets` knows the OpenRouter key shape but not this provider's key,
   * and an error body can echo whatever we sent. Remove our own key first,
   * then fall back to the shared patterns.
   */
  private scrub(text: string): string {
    const withoutOwnKey =
      this.cfg.apiKey.length > 0 ? text.split(this.cfg.apiKey).join('[redacted]') : text;
    return scrubSecrets(withoutOwnKey);
  }

  private wrap(err: unknown): LlmError {
    if (err instanceof LlmError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      return new LlmError('request aborted', 'ABORTED', false);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new LlmError(`network error: ${this.scrub(message)}`, 'NETWORK', true);
  }
}

/**
 * The goal as it appears in the prompt, for the memory note. It normally
 * arrives in the cycle prompt rather than the system prompt, so both are
 * searched before giving up.
 */
function goalFromPrompt(request: LlmRequest): string {
  const texts = request.messages.filter((m) => m.role !== 'tool').map((m) => m.content);
  for (const text of texts.reverse()) {
    const match = /^\s*GOAL:\s*(.+)$/m.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return 'the current goal';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('aborted while backing off', 'ABORTED', false));
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(new LlmError('aborted while backing off', 'ABORTED', false));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}