# Jev Decision Provider — Design

**Date:** 2026-10-11
**Status:** Approved
**Scope:** A second `LLMProvider` implementation that drives the agent with OpenCode Zen's
`jev-1.13-free` "System One" model instead of a chat model.

## Problem

The agent currently decides through `OpenRouterProvider`, which posts to
`{baseUrl}/chat/completions` and expects either native tool calls or a JSON object
(`src/llm/openrouter.ts:145`).

`jev-1.13-free` is not a chat model. On OpenCode Zen it is exposed at
`https://opencode.ai/zen/v1/systemone`. It takes a `state` string plus *typed questions*
and returns *values, probability distributions and confidence*. It performs no text
generation, has no tool-calling endpoint and rejects `response_format`. Pointing the
existing provider at it would fail at the HTTP layer, so a new provider is required.

## Constraints this design accepts

- **No free text from the model.** `reason` and `remember` are produced by code, never by
  the model. They are templated from the returned probabilities.
- **No arguments from the model.** Jev chooses *what* to do; the concrete argument values
  are filled in by deterministic per-tool builders.
- **No conversation history.** Each request is a single independent evaluation of a state.
  `request.messages` history is not replayed; the most recent user message (the turn
  situation) and the system prompt are folded into the state string instead.
- **Free tier.** Jev 1.13 Free is listed at $0 input / $0 output, "available for a limited
  time". OpenCode Zen publishes no request-per-minute figure for free models; the only
  documented ceiling is a per-workspace monthly spend limit. A free model never consumes
  that budget, and Zen's $20 auto-reload below a $5 balance is likewise never triggered by
  it. Rate-limit handling (HTTP 429) is still implemented for the paid `jev-1.13` and for
  general robustness.

## Architecture

### Provider selection

`src/index.ts:59` currently hardcodes one provider. It becomes a factory driven by config:

```ts
const provider: LLMProvider =
  control ?? (cfg.llm.provider === 'jev' ? new JevProvider(cfg.jev, logger)
                                       : new OpenRouterProvider(cfg.llm, logger));
```

### No changes to the agent

`Agent.interpret()` (`src/agent/agent.ts:398`) accepts `response.toolCalls[0]` regardless of
the requested output mode. `JevProvider` returns a single tool call, so the existing Zod
argument validation, tool registry gating, memory, observer compression and safety layer
all continue to work untouched.

`JevProvider.supportsToolCalling()` returns `false`, because Jev genuinely has no
tool-calling endpoint. The request is therefore issued with `mode: 'json'`, which the
provider ignores in favour of its own question schema.

### New files

| File | Responsibility |
| --- | --- |
| `src/llm/jev.ts` | `JevProvider implements LLMProvider` — HTTP, retries, response mapping |
| `src/llm/jev-questions.ts` | Builds the question payload from an `LlmRequest` + parsed observation |
| `src/llm/jev-args.ts` | `argBuilders`: one pure function per tool name |
| `src/llm/jev-format.ts` | Template rendering for `reason` and `remember` |

Splitting these keeps each file small enough to read in one sitting; `jev.ts` has no
knowledge of Minecraft, `jev-args.ts` has no knowledge of HTTP.

## The request

One HTTP call per turn, carrying every question in parallel.

**`state`** is a single string built from, in order: the system prompt, the most recent
user message (the turn situation), and a compact tail of recent events.

**Questions:**

| Question | Type | Role |
| --- | --- | --- |
| `tool` | `choice` | Criteria are the registry's tools, each keyed by name with its description. Returns the winner and a distribution. |
| `target` | `choice` | Criteria are up to 8 block types observed nearby, ordered by proximity. Feeds `mine.block`, `place_block.block`, `observe.focus`. |
| `urgency` | `score` | Rubric `[calm, tense, critical]`. Scales `mine.count`, `attack.count` and wait durations. |
| `goal_complete` | `noul` | Thresholded at 0.5 to produce the boolean. |
| `remember_worth` | `noul` | Thresholded at 0.6; above it a templated note is attached. |

### Wire format

```
POST {baseUrl}/systemone
Authorization: Bearer {apiKey}
Content-Type: application/json

{ "model": "jev-1.13-free", "state": "...", "questions": { ... } }
```

The response carries one answer per question id, under the matching id, each with the
value for its type, `probabilities` for `choice`/`score`, and `confidence` for
`choice`/`score`.

## Argument filling

`argBuilders` maps each registered tool name to a pure function
`(answers, observation) => Record<string, unknown>`. Because the `tool` criteria are
generated from the live registry, the winning name is always a registered tool; the
`tools.has()` check in `Agent.interpret` cannot fail for this provider.

Examples:

- `mine` → `{ block: answers.target, count: urgency === 'critical' ? 6 : 3, collect: true }`
- `move_to` → the relative offset of the nearest observed instance of the target block,
  with the current `y` preserved
- `attack` → the nearest hostile entity id, `count` scaled by urgency
- `craft` → the first inventory item with a known recipe, `{ item, count: 1 }`
- `observe` → `{ focus: answers.target }`, or `{}` when no target was offered
- `say` → a fixed acknowledgement string; Jev cannot author chat text

When a builder cannot fill a required argument, it returns `{}` and the existing Zod
validation in the registry reports the omission through the normal correction path.

## Text fields

`reason` is rendered from the returned data, not generated:

```
jev: mine oak_log (p=0.42) | top: observe 0.21, move_to 0.14 | urgency=tense | conf=0.55
```

`remember` is a state record rather than a model-authored note:

```
Plan: <goal> → currently mine oak_log
```

`goal_complete` is the `noul` answer thresholded at 0.5.

## Error handling

The retry, backoff, timeout and secret-scrubbing behaviour of `OpenRouterProvider` is
mirrored:

| Condition | Code | Retryable |
| --- | --- | --- |
| HTTP 401 / 403 | `AUTH` | no |
| HTTP 429 | `RATE_LIMIT` | yes, with a 2s backoff floor |
| HTTP 5xx | `SERVER` | yes |
| Timeout | `TIMEOUT` | yes |
| Network failure | `NETWORK` | yes |
| Missing / malformed `tool` answer | `BAD_RESPONSE` | yes |
| Non-JSON body | `BAD_RESPONSE` | yes |

Jev is deterministic for a given state, so retrying the identical payload is meaningful
and the agent's `MAX_DECISION_ATTEMPTS` correction loop is never entered.

**Low confidence is not an error.** When the winning tool's probability falls below
`JEV_CONFIDENCE_THRESHOLD` (default 0.25) a valid tool call is still produced, but
`content` carries `low confidence (p=0.11)` so the turn log shows it. Failing the turn
instead would burn cycles without improving the choice.

## Configuration

New variables, additive; nothing existing changes meaning.

```
LLM_PROVIDER=openrouter            # openrouter | jev
JEV_API_KEY=                       # falls back to OPENROUTER_API_KEY when empty
JEV_MODEL=jev-1.13-free
JEV_BASE_URL=https://opencode.ai/zen/v1
JEV_REQUEST_TIMEOUT_MS=30000
JEV_MAX_RETRIES=2
JEV_CONFIDENCE_THRESHOLD=0.25      # 0..1
```

`JEV_API_KEY` falls back to `OPENROUTER_API_KEY` so a single Zen key in the existing
variable also works. `.env`, `.env.example`, `docs/configuration.md` and `README.md` are
updated. `HELP_TEXT` documents the new provider choice.

## Tests

`tests/jev.test.ts`, with `fetch` mocked — no real API calls:

- the question payload has all three question types in the right places
- a `choice` response maps to a valid single tool call; the `content` template renders
- each `argBuilder` fed a realistic turn observation passes its real Zod schema
- low-probability winner appends the confidence note without changing the tool
- 401 does not retry; 429, 500 and timeouts retry the configured number of times
- `JEV_*` env validation, including the `OPENROUTER_API_KEY` fallback and threshold bounds
  (appended to `tests/config.test.ts`)

## Out of scope

Multi-turn conversation replay, streaming responses, automatic fallback to the OpenRouter
chat provider, and per-tool custom question schemas.