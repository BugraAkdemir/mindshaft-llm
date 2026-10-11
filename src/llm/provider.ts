/**
 * Provider-agnostic LLM contract.
 *
 * Nothing in `src/minecraft` or `src/tools` imports an HTTP client directly:
 * swapping OpenRouter for another OpenAI-compatible endpoint (or a local model)
 * only requires a new implementation of `LLMProvider`.
 */

import type { WorldState } from '../types.js';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Required when `role === 'tool'` — echoes the id of the call being answered. */
  toolCallId?: string;
  name?: string;
  /** Assistant turns that requested tools replay them so the model keeps context. */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. */
  arguments: string;
}

export type LlmOutputMode = 'tools' | 'json';

export interface LlmRequest {
  messages: LlmMessage[];
  mode: LlmOutputMode;
  /**
   * Tool specs for native tool calling. Sent regardless of `mode`: a provider
   * running in JSON mode may still need the catalogue to ask its own questions
   * about what to do.
   */
  tools?: LlmToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * The structured turn state. Providers that cannot read prose — such as a
   * System One decision model — take their inputs from here rather than
   * re-parsing `messages`.
   */
  observation?: WorldState;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  model: string;
  finishReason: string | null;
  usage?: LlmUsage;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /**
   * False once the provider has learned (from a real API response) that the
   * configured model cannot do native tool calling. The agent then permanently
   * falls back to strict-JSON mode.
   */
  supportsToolCalling(): boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Errors that a provider raises. `retryable` drives the backoff loop. */
export class LlmError extends Error {
  public override readonly name = 'LlmError';

  public constructor(
    message: string,
    public readonly code:
      | 'AUTH'
      | 'RATE_LIMIT'
      | 'TIMEOUT'
      | 'NETWORK'
      | 'BAD_RESPONSE'
      | 'TOOLS_UNSUPPORTED'
      | 'SERVER'
      | 'ABORTED',
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}
