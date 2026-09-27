import { z } from 'zod';
import type { AgentDecision } from '../types.js';

/**
 * Wire-level shape the model must produce in JSON mode. Field names are
 * normalised before validation (see `normalizeDecisionShape`) because models
 * routinely emit `name`/`args`/`parameters` instead of `tool`/`arguments`.
 */
export const DecisionSchema = z.object({
  reason: z.string().trim().max(600).default(''),
  tool: z
    .string()
    .trim()
    .min(1, 'tool name must not be empty')
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'tool name must be lower_snake_case'),
  arguments: z.record(z.string(), z.unknown()).default({}),
  remember: z.string().trim().max(240).optional(),
  goal_complete: z.boolean().optional(),
});

export type ParseFailureCode =
  | 'EMPTY_RESPONSE'
  | 'NO_JSON_FOUND'
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH';

export interface ParseSuccess {
  ok: true;
  decision: AgentDecision;
}

export interface ParseFailure {
  ok: false;
  code: ParseFailureCode;
  /** Message sent back to the model as a correction turn. */
  message: string;
}

export type ParseOutcome = ParseSuccess | ParseFailure;

/* ───────────────────────── JSON extraction ────────────────────────────── */

/**
 * Pulls the first syntactically balanced JSON object out of arbitrary text.
 *
 * Handles the three things models actually do wrong: wrapping the object in
 * ```json fences, prefixing it with prose, and appending an explanation after
 * the closing brace. String literals and escapes are tracked so a `}` inside a
 * string does not terminate the scan early.
 */
export function extractJsonObject(text: string): string | null {
  const stripped = stripCodeFences(text);

  for (let start = 0; start < stripped.length; start += 1) {
    if (stripped[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < stripped.length; i += 1) {
      const ch = stripped[i]!;

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return stripped.slice(start, i + 1);
        }
      }
    }
    // Unbalanced from this `{`; try the next one.
  }

  return null;
}

/**
 * Removes ```/```json fences. When a fenced block exists its contents are
 * returned on their own, since that is almost always the intended payload.
 */
export function stripCodeFences(text: string): string {
  const fenced = /```(?:json|JSON|js|javascript)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

const TOOL_KEYS = ['tool', 'name', 'action', 'tool_name', 'toolName', 'function'] as const;
const ARG_KEYS = [
  'arguments',
  'args',
  'parameters',
  'params',
  'input',
  'tool_input',
  'toolInput',
] as const;
const REASON_KEYS = ['reason', 'reasoning', 'thought', 'thinking', 'rationale', 'why'] as const;

/**
 * Maps common alias keys onto the canonical decision shape. Being permissive
 * here is safe: the result is still validated by `DecisionSchema`, and each
 * tool's own Zod schema validates the arguments afterwards.
 */
export function normalizeDecisionShape(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of TOOL_KEYS) {
    const candidate = input[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      out['tool'] = candidate.trim().toLowerCase();
      break;
    }
    // `{"function": {"name": "...", "arguments": {...}}}`
    if (key === 'function' && typeof candidate === 'object' && candidate !== null) {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested['name'] === 'string') {
        out['tool'] = nested['name'].trim().toLowerCase();
        if (nested['arguments'] !== undefined) out['arguments'] = nested['arguments'];
      }
      break;
    }
  }

  if (out['arguments'] === undefined) {
    for (const key of ARG_KEYS) {
      if (input[key] !== undefined) {
        out['arguments'] = input[key];
        break;
      }
    }
  }

  for (const key of REASON_KEYS) {
    if (typeof input[key] === 'string') {
      out['reason'] = input[key];
      break;
    }
  }

  if (typeof input['remember'] === 'string') out['remember'] = input['remember'];
  if (typeof input['fact'] === 'string' && out['remember'] === undefined) {
    out['remember'] = input['fact'];
  }

  const complete = input['goal_complete'] ?? input['goalComplete'] ?? input['done'];
  if (typeof complete === 'boolean') out['goal_complete'] = complete;

  // Arguments may arrive as a JSON string rather than an object.
  if (typeof out['arguments'] === 'string') {
    const raw = (out['arguments'] as string).trim();
    if (raw === '') {
      out['arguments'] = {};
    } else {
      try {
        const parsed: unknown = JSON.parse(raw);
        out['arguments'] =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
      } catch {
        out['arguments'] = {};
      }
    }
  }
  if (
    out['arguments'] !== undefined &&
    (typeof out['arguments'] !== 'object' || out['arguments'] === null || Array.isArray(out['arguments']))
  ) {
    out['arguments'] = {};
  }

  return out;
}

/** Parses a raw JSON-mode completion into a validated `AgentDecision`. */
export function parseDecisionFromText(text: string | null): ParseOutcome {
  if (text === null || text.trim() === '') {
    return {
      ok: false,
      code: 'EMPTY_RESPONSE',
      message: 'Your response was empty. Reply with a single JSON object: {"reason":"...","tool":"...","arguments":{...}}',
    };
  }

  const json = extractJsonObject(text);
  if (json === null) {
    return {
      ok: false,
      code: 'NO_JSON_FOUND',
      message:
        'No JSON object was found in your reply. Respond with ONLY a JSON object of the form ' +
        '{"reason":"...","tool":"tool_name","arguments":{...}} and no surrounding prose.',
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_JSON',
      message: `Your JSON could not be parsed (${err instanceof Error ? err.message : 'syntax error'}). Send a single valid JSON object with keys "reason", "tool" and "arguments".`,
    };
  }

  return validateDecision(raw);
}

/** Validates an already-decoded object (used by both JSON and tools mode). */
export function validateDecision(raw: unknown): ParseOutcome {
  const normalized = normalizeDecisionShape(raw);
  if (normalized === null) {
    return {
      ok: false,
      code: 'SCHEMA_MISMATCH',
      message: 'Expected a JSON object at the top level, not an array or primitive.',
    };
  }

  const parsed = DecisionSchema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    return {
      ok: false,
      code: 'SCHEMA_MISMATCH',
      message: `Your action did not match the required schema (${issues}). Required shape: {"reason":"short explanation","tool":"one of the available tool names","arguments":{...}}`,
    };
  }

  const data = parsed.data;
  const decision: AgentDecision = {
    reason: data.reason,
    tool: data.tool,
    arguments: data.arguments,
  };
  if (data.remember !== undefined) decision.remember = data.remember;
  if (data.goal_complete !== undefined) decision.goalComplete = data.goal_complete;
  return { ok: true, decision };
}

/**
 * Builds an `AgentDecision` from a native tool call. `fallbackReason` is the
 * assistant message content, which most models use for their explanation.
 */
export function decisionFromToolCall(
  name: string,
  argumentsJson: string,
  fallbackReason: string | null,
): ParseOutcome {
  let args: unknown = {};
  const trimmed = argumentsJson.trim();
  if (trimmed !== '') {
    try {
      args = JSON.parse(trimmed);
    } catch {
      // Some models emit almost-JSON; try the balanced-object extractor.
      const recovered = extractJsonObject(trimmed);
      if (recovered === null) {
        return {
          ok: false,
          code: 'INVALID_JSON',
          message: `The arguments for tool "${name}" were not valid JSON. Send the arguments as a JSON object.`,
        };
      }
      try {
        args = JSON.parse(recovered);
      } catch {
        return {
          ok: false,
          code: 'INVALID_JSON',
          message: `The arguments for tool "${name}" were not valid JSON. Send the arguments as a JSON object.`,
        };
      }
    }
  }

  // Models sometimes smuggle the reason into the arguments object.
  let reason = fallbackReason?.trim() ?? '';
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    const bag = args as Record<string, unknown>;
    for (const key of REASON_KEYS) {
      if (typeof bag[key] === 'string' && reason === '') {
        reason = (bag[key] as string).trim();
      }
    }
  }

  return validateDecision({ tool: name, arguments: args, reason });
}
