# Jev Decision Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent be driven by OpenCode Zen's `jev-1.13-free` System One model instead of a chat model.

**Architecture:** A second `LLMProvider` implementation posts a single request per turn to Zen's
`/systemone` endpoint, carrying a state string plus five typed questions (choice/score/noul). The
winning `choice` becomes the tool name; argument values come from deterministic per-tool builders fed
the turn's `WorldState`. `Agent` keeps calling `interpret()` with a normal single tool call, so
validation, the tool registry and the safety layer are unchanged.

**Tech Stack:** TypeScript (strict, ESM), Node 20 fetch, Zod 4, vitest, pino.

## Global Constraints

- Node `>=20.11.0`; build with `npm run build`; verify with `npm run typecheck` and `npm run test`.
- No new runtime dependencies. No new dev dependencies. No web framework.
- Tests live in `tests/*.test.ts`, use vitest, and mock `globalThis.fetch` — **no real API calls**.
- Never log or echo an API key; reuse `scrubSecrets` from `src/utils/logger.ts`.
- `src/types.ts` already exports `AgentEvent` (memory events). **Do not reuse that name** for the new
  provider's own types.
- Endpoints: `jev-1.13-free` → `https://opencode.ai/zen/v1/systemone`.
- A free model costs $0 and has no published RPM limit; still handle HTTP 429 as retryable.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/config/config.ts` | **Modify** — add `JevConfig`, `LLM_PROVIDER`, `JEV_*` env |
| `src/llm/provider.ts` | **Modify** — add `observation` to `LlmRequest` |
| `src/agent/agent.ts` | **Modify** — pass `observation`; always send `tools` |
| `src/llm/jev-format.ts` | **Create** — pure renderers for `reason` / `remember` |
| `src/llm/jev-questions.ts` | **Create** — builds the `/systemone` payload from an `LlmRequest` |
| `src/llm/jev-craft.ts` | **Create** — greedy next-craftable lookup from inventory counts |
| `src/llm/jev-args.ts` | **Create** — one argument builder per tool name |
| `src/llm/jev.ts` | **Create** — `JevProvider implements LLMProvider` |
| `src/index.ts` | **Modify** — provider factory |
| `tests/jev.test.ts` | **Create** — provider tests |
| `tests/jev-args.test.ts` | **Create** — builder tests |
| `tests/config.test.ts` | **Modify** — `JEV_*` env tests |

## Interfaces consumed and produced

```ts
// src/config/config.ts
export type LlmProviderName = 'openrouter' | 'jev';
export interface JevConfig {
  apiKey: string;
  model: string;          // 'jev-1.13-free'
  baseUrl: string;        // 'https://opencode.ai/zen/v1' (no trailing slash)
  requestTimeoutMs: number;
  maxRetries: number;
  confidenceThreshold: number; // 0..1
}
// Config gains:  jev: JevConfig
// LlmConfig gains: provider: LlmProviderName

// src/llm/provider.ts
export interface LlmRequest {
  messages: LlmMessage[];
  mode: LlmOutputMode;
  tools?: LlmToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  observation?: WorldState;   // ADDED — full structured turn state
}

// src/llm/jev.ts
export interface JevAnswers {
  tool: string;              // winning tool name, always from the registry
  toolProbabilities: Record<string, number>;
  toolConfidence: number;
  target?: string;           // winning block type, undefined when no candidates
  urgency: 'calm' | 'tense' | 'critical';
  goalComplete: boolean;
  rememberWorth: boolean;
}
export class JevProvider implements LLMProvider {
  constructor(cfg: JevConfig, logger?: Logger);
  readonly name: 'jev';
  readonly model: string;
  supportsToolCalling(): false;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// src/llm/jev-args.ts
export function buildArguments(
  answers: JevAnswers,
  observation: WorldState | undefined,
): Record<string, unknown>;
```

---

### Task 1: Configuration for the Jev provider

**Files:**
- Modify: `src/config/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LlmProviderName`, `JevConfig`, `Config.jev`, `LlmConfig.provider`, plus
  `parseArgs` support for `--llm-provider`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts`:

```ts
it('defaults to the openrouter provider and a jev block', () => {
  const cfg = loadConfig(MINIMAL_ENV, {}, true);
  expect(cfg.llm.provider).toBe('openrouter');
  expect(cfg.jev.model).toBe('jev-1.13-free');
  expect(cfg.jev.baseUrl).toBe('https://opencode.ai/zen/v1');
  expect(cfg.jev.confidenceThreshold).toBe(0.25);
});

it('falls back to OPENROUTER_API_KEY when JEV_API_KEY is blank', () => {
  const cfg = loadConfig({ ...MINIMAL_ENV, JEV_API_KEY: '   ' }, {}, true);
  expect(cfg.jev.apiKey).toBe('sk-or-v1-test');
});

it('prefers JEV_API_KEY when both are set', () => {
  const cfg = loadConfig({ ...MINIMAL_ENV, JEV_API_KEY: 'zen-key' }, {}, true);
  expect(cfg.jev.apiKey).toBe('zen-key');
});

it('rejects a confidence threshold outside 0..1', () => {
  expect(() =>
    loadConfig({ ...MINIMAL_ENV, JEV_CONFIDENCE_THRESHOLD: '1.4' }, {}, true),
  ).toThrow(ConfigError);
});

it('accepts --llm-provider jev', () => {
  const parsed = parseArgs(['--llm-provider', 'jev']);
  expect(parsed.errors).toEqual([]);
  expect(parsed.overrides.llmProvider).toBe('jev');
});

it('rejects an unknown provider name', () => {
  const parsed = parseArgs(['--llm-provider', 'ollama']);
  expect(parsed.errors[0]).toMatch(/--llm-provider/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `cfg.jev` is undefined and `--llm-provider` is an unknown flag.

- [ ] **Step 3: Implement**

In `src/config/config.ts`, extend `RawEnvSchema` (insert after `LLM_MAX_RETRIES`, line 63):

```ts
  LLM_PROVIDER: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'openrouter' : v.trim().toLowerCase()))
    .pipe(z.enum(['openrouter', 'jev'])),

  JEV_API_KEY: optionalString,
  JEV_MODEL: nonEmpty('jev-1.13-free'),
  JEV_BASE_URL: nonEmpty('https://opencode.ai/zen/v1'),
  JEV_REQUEST_TIMEOUT_MS: intIn(1_000, 300_000, 30_000),
  JEV_MAX_RETRIES: intIn(0, 5, 2),
  JEV_CONFIDENCE_THRESHOLD: floatIn(0, 1, 0.25),
```

Add the types and interface near `LlmConfig` (line 116):

```ts
export type LlmProviderName = 'openrouter' | 'jev';

export interface JevConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
  confidenceThreshold: number;
}
```

Add `provider: LlmProviderName;` to `LlmConfig` and `llmProvider?: LlmProviderName;` to
`CliOverrides`. Add `jev: JevConfig;` to `Config`.

In `loadConfig`, add `provider: overrides.llmProvider ?? e.LLM_PROVIDER,` to the `llm` block, and
add the `jev` block after it:

```ts
    jev: {
      apiKey: e.JEV_API_KEY ?? apiKey,
      model: e.JEV_MODEL,
      baseUrl: e.JEV_BASE_URL.replace(/\/+$/, ''),
      requestTimeoutMs: e.JEV_REQUEST_TIMEOUT_MS,
      maxRetries: e.JEV_MAX_RETRIES,
      confidenceThreshold: e.JEV_CONFIDENCE_THRESHOLD,
    },
```

In `parseArgs`, add `'--llm-provider'` to `FLAGS_WITH_VALUES` (line 320) and add a `case` beside
`'--mode'`:

```ts
      case '--llm-provider': {
        const name = z.string().parse(value.toLowerCase());
        if (name === 'openrouter' || name === 'jev') {
          overrides.llmProvider = name;
        } else {
          errors.push(`Invalid --llm-provider "${value}" (expected openrouter | jev).`);
        }
        break;
      }
```

Update `HELP_TEXT` with two lines after the `--mode` entry:

```
  --llm-provider <openrouter|jev>
                       Which provider drives the agent (default: openrouter).
```

- [ ] **Step 4: Run typecheck and the config tests**

Run: `npm run typecheck && npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts tests/config.test.ts
git commit -m "feat(config): add JEV_* settings and --llm-provider"
```

---

### Task 2: Hand the structured observation to the provider

**Files:**
- Modify: `src/llm/provider.ts:33-40`
- Modify: `src/agent/agent.ts:314-318`
- Test: `tests/jev-request.test.ts` (create)

**Interfaces:**
- Consumes: `WorldState` from `src/types.ts`.
- Produces: `LlmRequest.observation?: WorldState`. Every provider must send `tools` regardless of
  `mode`, so `JevProvider` can build its `tool` question in JSON mode.

- [ ] **Step 1: Write the failing test**

Create `tests/jev-request.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { ExternalControlProvider } from '../src/llm/external.js';
import type { LlmRequest, LlmResponse } from '../src/llm/provider.js';
import { createMockBot } from './helpers/mock-bot.js';
import { testConfig } from './helpers/fixtures.js';

class CapturingProvider {
  public readonly model = 'capture';
  public readonly seen: LlmRequest[] = [];
  public supportsToolCalling(): boolean {
    return false;
  }
  public async complete(request: LlmRequest): Promise<LlmResponse> {
    this.seen.push(request);
    return {
      content: '{"reason":"r","tool":"observe","arguments":{}}',
      toolCalls: [],
      model: this.model,
      finishReason: 'stop',
      latencyMs: 1,
    };
  }
}

it('sends the tool specs and the structured observation to the provider', async () => {
  const bot = createMockBot();
  const provider = new CapturingProvider();
  const agent = new Agent(testConfig(), provider, undefined);
  await agent.start(bot);

  await agent.runCycle();

  const request = provider.seen[0]!;
  expect(request.tools?.map((t) => t.name)).toContain('mine');
  expect(request.observation?.player.health).toBeTypeOf('number');
  expect(Array.isArray(request.observation?.nearbyBlocks)).toBe(true);
});

it('keeps ExternalControlProvider usable without an observation', () => {
  expect(ExternalControlProvider.prototype.complete).toBeTypeOf('function');
});
```

If `Agent.start` does not accept a bot argument, build the agent the way
`tests/integration.test.ts` does and copy that setup verbatim instead of inventing one.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/jev-request.test.ts`
Expected: FAIL — `request.tools` is undefined because the agent only sends tools in `tools` mode.

- [ ] **Step 3: Implement**

In `src/llm/provider.ts`, import `WorldState` and add the field:

```ts
import type { WorldState } from '../types.js';
```

```ts
  /**
   * The structured turn state. Providers that cannot parse prose — such as the
   * System One decision model — read their inputs from here instead of
   * re-parsing `messages`.
   */
  observation?: WorldState;
```

In `src/agent/agent.ts`, replace the request construction at line 314:

```ts
        response = await this.provider.complete({
          messages,
          mode,
          tools: this.tools.specs(),
          observation: state,
        });
```

`OpenRouterProvider.once` already gates on `request.mode === 'tools'` (line 111), so sending the
specs unconditionally changes nothing for it.

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm run test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/provider.ts src/agent/agent.ts tests/jev-request.test.ts
git commit -m "feat(llm): pass tool specs and WorldState to every provider"
```

---

### Task 3: Reason and remember templates

**Files:**
- Create: `src/llm/jev-format.ts`
- Test: `tests/jev-format.test.ts` (create)

**Interfaces:**
- Consumes: `JevAnswers` (declared in `src/llm/jev.ts`; to avoid a circular import, declare the
  shared shape in this file and re-export it from `jev.ts`).
- Produces: `formatReason`, `formatRemember`.

- [ ] **Step 1: Write the failing test**

Create `tests/jev-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatReason, formatRemember } from '../src/llm/jev-format.js';

const answers = {
  tool: 'mine',
  toolProbabilities: { mine: 0.42, observe: 0.21, move_to: 0.14 },
  toolConfidence: 0.55,
  target: 'oak_log',
  urgency: 'tense',
  goalComplete: false,
  rememberWorth: true,
} as const;

describe('formatReason', () => {
  it('names the tool, the probability and the runner-up distribution', () => {
    const reason = formatReason(answers);
    expect(reason).toContain('mine');
    expect(reason).toContain('oak_log');
    expect(reason).toContain('p=0.42');
    expect(reason).toContain('observe 0.21');
    expect(reason).toContain('urgency=tense');
  });

  it('omits the target when none was offered', () => {
    expect(formatReason({ ...answers, target: undefined })).not.toContain('undefined');
  });

  it('keeps the reason inside the 600 character contract', () => {
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`tool_${i}`, i / 100]),
    );
    expect(formatReason({ ...answers, toolProbabilities: many }).length).toBeLessThanOrEqual(600);
  });
});

describe('formatRemember', () => {
  it('records the goal and the current action', () => {
    const note = formatRemember('Gather wood', answers);
    expect(note).toContain('Gather wood');
    expect(note).toContain('mine');
    expect(note).toContain('oak_log');
  });

  it('stays inside the 240 character contract', () => {
    expect(formatRemember('x'.repeat(1000), answers).length).toBeLessThanOrEqual(240);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/jev-format.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/llm/jev-format.ts`:

```ts
import type { BlockGroup, EntityInfo } from '../types.js';

/** Everything the System One endpoint answered, normalised. */
export interface JevAnswers {
  /** Winning tool name. Always one of the criteria the request offered. */
  tool: string;
  toolProbabilities: Record<string, number>;
  toolConfidence: number;
  /** Winning block type, or undefined when no candidates were offered. */
  target?: string;
  urgency: 'calm' | 'tense' | 'critical';
  goalComplete: boolean;
  rememberWorth: boolean;
}

const REASON_LIMIT = 600;
const REMEMBER_LIMIT = 240;

function percent(value: number): string {
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Top alternatives, so a single winner never looks like certainty. */
function runnerUp(probabilities: Record<string, number>, winner: string): string {
  return Object.entries(probabilities)
    .filter(([name]) => name !== winner)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, p]) => `${name} ${percent(p)}`)
    .join(', ');
}

export function formatReason(answers: JevAnswers): string {
  const parts = [`jev: ${answers.tool}`];
  if (answers.target) parts.push(answers.target);
  parts.push(`(p=${percent(answers.toolProbabilities[answers.tool] ?? 0)})`);

  const alternatives = runnerUp(answers.toolProbabilities, answers.tool);
  if (alternatives) parts.push(`| top: ${alternatives}`);
  parts.push(`| urgency=${answers.urgency}`);
  parts.push(`| conf=${percent(answers.toolConfidence)}`);

  return parts.join(' ').slice(0, REASON_LIMIT);
}

export function formatRemember(goal: string, answers: JevAnswers): string {
  const subject = answers.target ? `${answers.tool} ${answers.target}` : answers.tool;
  return `Plan: ${goal} → currently ${subject}`.slice(0, REMEMBER_LIMIT);
}

/** Nearest group of a given type, used by the movement and mining builders. */
export function nearestGroup(groups: readonly BlockGroup[], type: string): BlockGroup | undefined {
  return groups.filter((g) => g.type === type).sort((a, b) => a.distance - b.distance)[0];
}

export function nearestOf(
  entities: readonly EntityInfo[],
  category: EntityInfo['category'],
): EntityInfo | undefined {
  return entities
    .filter((e) => e.category === category)
    .sort((a, b) => a.distance - b.distance)[0];
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/jev-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/jev-format.ts tests/jev-format.test.ts
git commit -m "feat(jev): reason and remember templates"
```

---

### Task 4: Greedy next-craftable lookup

**Files:**
- Create: `src/llm/jev-craft.ts`
- Test: `tests/jev-craft.test.ts` (create)

**Interfaces:**
- Consumes: `Record<string, number>` (the `inventoryCounts` field of `WorldState`).
- Produces: `nextCraftable(counts): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/jev-craft.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextCraftable } from '../src/llm/jev-craft.js';

describe('nextCraftable', () => {
  it('turns logs into planks', () => {
    expect(nextCraftable({ oak_log: 3 })).toBe('oak_planks');
  });

  it('turns planks into a crafting table', () => {
    expect(nextCraftable({ oak_log: 1 })).toBe('oak_planks');
    expect(nextCraftable({ oak_planks: 4 })).toBe('crafting_table');
  });

  it('escalates to a wooden pickaxe once a table is available', () => {
    expect(nextCraftable({ oak_planks: 8, stick: 4 })).toBe('wooden_pickaxe');
  });

  it('escalates to stone tools from cobblestone', () => {
    expect(nextCraftable({ cobblestone: 8, stick: 4 })).toBe('stone_pickaxe');
  });

  it('returns undefined for an empty inventory', () => {
    expect(nextCraftable({})).toBeUndefined();
  });

  it('ignores items the ladder does not use', () => {
    expect(nextCraftable({ dirt: 40, torch: 12 })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/jev-craft.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/llm/jev-craft.ts`:

```ts
/**
 * A small greedy ladder, in priority order. The System One model answers
 * "craft or not"; this decides *what*, because a decision model returns no
 * arguments. Kept deliberately short — a wrong item is a wasted turn, a
 * missing item is a recoverable one.
 */
interface Rule {
  item: string;
  from: Record<string, number>;
}

const RULES: Rule[] = [
  { item: 'crafting_table', from: { planks: 4 } },
  { item: 'torch', from: { stick: 1, coal: 1 } },
  { item: 'wooden_pickaxe', from: { planks: 3, stick: 2 } },
  { item: 'wooden_axe', from: { planks: 3, stick: 2 } },
  { item: 'stone_pickaxe', from: { cobblestone: 3, stick: 2 } },
  { item: 'stone_axe', from: { cobblestone: 3, stick: 2 } },
  { item: 'stone_sword', from: { cobblestone: 2, stick: 1 } },
  { item: 'furnace', from: { cobblestone: 8 } },
];

function has(counts: Record<string, number>, need: Record<string, number>): boolean {
  return Object.entries(need).every(([item, amount]) => (counts[item] ?? 0) >= amount);
}

/** Total plank-equivalents, counting every log species the game turns into 4. */
export function plankCount(counts: Record<string, number>): number {
  const logs = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];
  const fromLogs = logs.reduce((total, id) => total + (counts[id] ?? 0), 0) * 4;
  return fromLogs + (counts['oak_planks'] ?? 0) + (counts['birch_planks'] ?? 0);
}

export function nextCraftable(counts: Record<string, number>): string | undefined {
  const expanded: Record<string, number> = { ...counts, planks: plankCount(counts) };
  return RULES.find((rule) => has(expanded, rule.from))?.item;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/jev-craft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/jev-craft.ts tests/jev-craft.test.ts
git commit -m "feat(jev): greedy next-craftable ladder"
```

---

### Task 5: The question payload

**Files:**
- Create: `src/llm/jev-questions.ts`
- Test: `tests/jev-questions.test.ts` (create)

**Interfaces:**
- Consumes: `LlmRequest`, `WorldState`.
- Produces: `JevPayload`, `buildPayload(request)`, `buildState(request)`, `candidateTargets(observation)`.

- [ ] **Step 1: Write the failing test**

Create `tests/jev-questions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPayload, buildState, candidateTargets } from '../src/llm/jev-questions.js';
import type { LlmRequest } from '../src/llm/provider.js';
import type { BlockGroup, WorldState } from '../src/types.js';

const tools = [
  { name: 'mine', description: 'Break a block.', parameters: {} },
  { name: 'observe', description: 'Look around.', parameters: {} },
];

const groups: BlockGroup[] = [
  { type: 'oak_log', count: 12, nearest: { x: 1, y: 64, z: 2 }, distance: 3, direction: 'north', relative: { x: 1, y: 0, z: -2 } },
  { type: 'stone', count: 90, nearest: { x: 0, y: 60, z: 0 }, distance: 8, direction: 'down', relative: { x: 0, y: -4, z: 0 } },
  { type: 'dirt', count: 40, nearest: { x: 5, y: 63, z: 5 }, distance: 6, direction: 'south', relative: { x: 5, y: -1, z: 5 } },
];

const observation = { nearbyBlocks: groups } as unknown as WorldState;

const request: LlmRequest = {
  messages: [
    { role: 'system', content: 'SYSTEM RULES' },
    { role: 'user', content: 'HP 20, dusk, oak_log nearby' },
  ],
  mode: 'json',
  tools,
  observation,
};

describe('buildPayload', () => {
  it('offers every tool as a choice criterion', () => {
    const payload = buildPayload(request);
    expect(Object.keys(payload.questions['tool']!.criteria!)).toEqual(['mine', 'observe']);
  });

  it('asks for choice, score and noul questions', () => {
    const q = buildPayload(request).questions;
    expect(q['tool']!.type).toBe('choice');
    expect(q['urgency']!.type).toBe('score');
    expect(q['goal_complete']!.type).toBe('noul');
    expect(q['remember_worth']!.type).toBe('noul');
  });

  it('scores urgency against a three step rubric', () => {
    expect(buildPayload(request).questions['urgency']!.criteria).toEqual([
      'calm',
      'tense',
      'critical',
    ]);
  });

  it('carries the configured model id', () => {
    expect(buildPayload(request, 'jev-1.13-free').model).toBe('jev-1.13-free');
  });

  it('omits the target question when nothing is nearby', () => {
    const bare = { ...request, observation: { nearbyBlocks: [] } as unknown as WorldState };
    expect(buildPayload(bare).questions['target']).toBeUndefined();
  });
});

describe('buildState', () => {
  it('includes the system prompt and the latest situation', () => {
    const state = buildState(request);
    expect(state).toContain('SYSTEM RULES');
    expect(state).toContain('HP 20, dusk, oak_log nearby');
  });
});

describe('candidateTargets', () => {
  it('sorts by proximity', () => {
    expect(candidateTargets(observation)).toEqual(['oak_log', 'dirt', 'stone']);
  });

  it('caps the list at eight entries', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...groups[0]!,
      type: `block_${i}`,
      distance: i,
    }));
    expect(candidateTargets({ nearbyBlocks: many } as unknown as WorldState)).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/jev-questions.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/llm/jev-questions.ts`:

```ts
import type { LlmRequest, LlmToolSpec } from './provider.js';
import type { WorldState } from '../types.js';

/* ──────────────────────────── wire shapes ─────────────────────────────── */

export interface JevQuestion {
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?: Record<string, string>;
}

export interface JevPayload {
  model: string;
  state: string;
  questions: Record<string, JevQuestion>;
}

/** At most this many block types are offered as targets. */
const MAX_TARGETS = 8;

/* ──────────────────────────── state string ────────────────────────────── */

/**
 * Jev has no conversation memory, so the whole context is one string: the
 * standing rules, then the current situation, then any operator instruction.
 */
export function buildState(request: LlmRequest): string {
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const latest = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return [
    '== Standing instructions ==',
    system.trim(),
    '== Current situation ==',
    latest.trim(),
  ].join('\n\n');
}

/* ──────────────────────────── candidates ──────────────────────────────── */

/** Nearby block types, nearest first. */
export function candidateTargets(observation: WorldState | undefined): string[] {
  return [...(observation?.nearbyBlocks ?? [])]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_TARGETS)
    .map((group) => group.type);
}

function toolCriteria(tools: readonly LlmToolSpec[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const tool of tools) criteria[tool.name] = tool.description;
  return criteria;
}

/* ──────────────────────────── payload ─────────────────────────────────── */

export function buildPayload(request: LlmRequest, model = 'jev-1.13-free'): JevPayload {
  const tools = request.tools ?? [];
  const targets = candidateTargets(request.observation);

  const questions: Record<string, JevQuestion> = {
    tool: {
      type: 'choice',
      instructions:
        'Which single action should the bot take right now, given its goal and situation? ' +
        'Answer with exactly one of the listed actions.',
      criteria: toolCriteria(tools),
    },
    urgency: {
      type: 'score',
      instructions: 'How much does the bot need to act urgently right now?',
      criteria: ['calm', 'tense', 'critical'],
    },
    goal_complete: {
      type: 'noul',
      instructions: 'Has the bot fully achieved its goal and can it stop now?',
    },
    remember_worth: {
      type: 'noul',
      instructions:
        'Is this step important enough to be written into long-term memory for future cycles?',
    },
  };

  if (targets.length > 0) {
    questions['target'] = {
      type: 'choice',
      instructions:
        'Which of these blocks or items should the action apply to? Choose the one that best ' +
        'advances the goal.',
      criteria: Object.fromEntries(
        targets.map((type) => [
          type,
          request.observation?.nearbyBlocks.find((g) => g.type === type)?.count ?? 1,
        ]),
      ),
    };
  }

  return { model, state: buildState(request), questions };
}
```

The `target` criteria values are occurrence counts, which is what the question is asking for —
"how available/useful is this block here".

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx vitest run tests/jev-questions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/jev-questions.ts tests/jev-questions.test.ts
git commit -m "feat(jev): build the System One question payload"
```

---

### Task 6: Per-tool argument builders

**Files:**
- Create: `src/llm/jev-args.ts`
- Test: `tests/jev-args.test.ts` (create)

**Interfaces:**
- Consumes: `JevAnswers` (`src/llm/jev-format.ts`), `WorldState`, `nextCraftable`.
- Produces: `buildArguments(answers, observation)`.

- [ ] **Step 1: Write the failing test**

Create `tests/jev-args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildArguments } from '../src/llm/jev-args.js';
import { AttackArgs, CollectArgs, CraftArgs, MineArgs, MoveToArgs, ObserveArgs } from '../src/tools/schemas.js';
import type { WorldState } from '../src/types.js';

const observation = {
  player: { position: { x: 10, y: 64, z: 20 }, health: 12, food: 18 },
  environment: { timeOfDay: 'dusk', isDay: false, stuckInPit: true },
  nearbyBlocks: [
    { type: 'oak_log', count: 12, nearest: { x: 11, y: 64, z: 18 }, distance: 3, direction: 'north', relative: { x: 1, y: 0, z: -2 } },
  ],
  entities: [
    { id: 42, type: 'zombie', name: 'Zombie', category: 'hostile', position: { x: 12, y: 64, z: 20 }, distance: 2, direction: 'east', relative: { x: 2, y: 0, z: 0 }, health: 20 },
  ],
  threats: [
    { id: 42, type: 'zombie', name: 'Zombie', category: 'hostile', position: { x: 12, y: 64, z: 20 }, distance: 2, direction: 'east', relative: { x: 2, y: 0, z: 0 }, health: 20 },
  ],
  inventory: [],
  inventoryCounts: { oak_log: 4, cobblestone: 9, stick: 3 },
} as unknown as WorldState;

const base = {
  tool: 'mine',
  toolProbabilities: { mine: 1 },
  toolConfidence: 1,
  target: 'oak_log',
  urgency: 'calm',
  goalComplete: false,
  rememberWorth: false,
} as const;

it('fills mine arguments and validates them against the real schema', () => {
  const args = buildArguments({ ...base, tool: 'mine' }, observation);
  expect(MineArgs.safeParse(args).success).toBe(true);
  expect(args['block']).toBe('oak_log');
});

it('scales the mine count with urgency', () => {
  expect(buildArguments({ ...base, urgency: 'critical' }, observation)['count']).toBe(6);
  expect(buildArguments({ ...base, urgency: 'calm' }, observation)['count']).toBe(3);
});

it('escapes a pit first, whatever the model chose', () => {
  const args = buildArguments({ ...base, tool: 'move_to' }, observation);
  expect(args['x']).toBe(11);
  expect(args['z']).toBe(18);
  expect(MoveToArgs.safeParse(args).success).toBe(true);
});

it('builds an attack from the nearest hostile entity', () => {
  const args = buildArguments({ ...base, tool: 'attack' }, observation);
  expect(args['entity_id']).toBe(42);
  expect(args['count']).toBeTypeOf('number');
});

it('crafts whatever the ladder says is next', () => {
  const args = buildArguments({ ...base, tool: 'craft' }, observation);
  expect(CraftArgs.safeParse(args).success).toBe(true);
  expect(args['item']).toBe('crafting_table');
});

it('collects when a loose item is the target', () => {
  const args = buildArguments({ ...base, tool: 'collect' }, observation);
  expect(CollectArgs.safeParse(args).success).toBe(true);
});

it('observes with the chosen focus', () => {
  const args = buildArguments({ ...base, tool: 'observe' }, observation);
  expect(ObserveArgs.safeParse(args).success).toBe(true);
  expect(args['focus']).toBe('oak_log');
});

it('never invents a target it was not given', () => {
  const args = buildArguments({ ...base, tool: 'mine', target: undefined }, observation);
  expect(args['block']).toBeUndefined();
  expect(MineArgs.safeParse(args).success).toBe(false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/jev-args.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/llm/jev-args.ts`:

```ts
import { nextCraftable } from './jev-craft.js';
import { nearestGroup, nearestOf, type JevAnswers } from './jev-format.js';
import type { WorldState } from '../types.js';

type Args = Record<string, unknown>;

const MINE_COUNT: Record<JevAnswers['urgency'], number> = { calm: 3, tense: 4, critical: 6 };
const ATTACK_COUNT: Record<JevAnswers['urgency'], number> = { calm: 1, tense: 2, critical: 3 };

/** Absolute coordinates of the targeted block, taken from its nearest instance. */
function targetPoint(answers: JevAnswers, observation: WorldState | undefined) {
  if (!answers.target || !observation) return undefined;
  return nearestGroup(observation.nearbyBlocks, answers.target)?.nearest;
}

type Builder = (answers: JevAnswers, observation: WorldState | undefined) => Args;

/**
 * One builder per registered tool. Every builder is pure and returns `{}` rather
 * than guessing when it lacks the information — the registry's Zod schema then
 * reports the omission through the normal correction path.
 */
const BUILDERS: Record<string, Builder> = {
  observe: (a) => (a.target ? { focus: a.target } : {}),

  mine: (a) => {
    if (!a.target) return {};
    return { block: a.target, count: MINE_COUNT[a.urgency], collect: true };
  },

  move_to: (a, o) => {
    const point = targetPoint(a, o);
    if (!point) return {};
    return { x: point.x, y: point.y, z: point.z };
  },

  look_at: (a, o) => {
    const point = targetPoint(a, o) ?? nearestOf(o?.entities ?? [], 'hostile')?.position;
    if (!point || !o) return {};
    return { x: point.x, y: point.y, z: point.z };
  },

  attack: (a, o) => {
    const target = nearestOf(o?.threats ?? [], 'hostile') ?? nearestOf(o?.entities ?? [], 'hostile');
    if (!target) return {};
    return { entity_id: target.id, count: ATTACK_COUNT[a.urgency] };
  },

  eat: (a, o) => {
    const food = (o?.inventoryCounts ?? {})['cooked_beef'] ?? 0;
    return food > 0 ? { item: 'cooked_beef' } : {};
  },

  equip: (a, o) => {
    const gear = (o?.inventoryCounts ?? {})['stone_pickaxe'] ?? 0;
    return gear > 0 ? { item: 'stone_pickaxe' } : {};
  },

  collect: () => ({ radius: 12, max_items: 5 }),

  craft: (a, o) => {
    const item = nextCraftable(o?.inventoryCounts ?? {});
    return item ? { item, count: 1 } : {};
  },

  smelt: (a, o) => {
    const counts = o?.inventoryCounts ?? {};
    const has = counts['iron_ore'] ?? counts['raw_iron'] ?? 0;
    const fuel = counts['coal'] ?? counts['oak_log'] ?? 0;
    const furnace = counts['furnace'] ?? 0;
    if (!has || !fuel || !furnace) return {};
    return { item: 'iron_ingot', count: 1 };
  },

  interact: (a, o) => {
    const target = nearestOf(o?.entities ?? [], 'item') ?? nearestOf(o?.entities ?? [], 'other');
    return target ? { entity_id: target.id } : {};
  },

  // A decision model cannot author prose, so this is a fixed acknowledgement.
  say: (a) => ({ message: a.target ? `Looking for ${a.target}.` : 'Working on it.' }),

  jump: () => ({ count: 1 }),
  pillar_up: (a) => ({ height: a.urgency === 'critical' ? 4 : 2 }),
  sneak: () => ({ enabled: true }),
  sprint: () => ({ enabled: true }),
  wait: (a) => ({
    ticks: a.urgency === 'critical' ? 1 : a.urgency === 'tense' ? 10 : 20,
    reason: 'waiting for the situation to change',
  }),
};

export function buildArguments(
  answers: JevAnswers,
  observation: WorldState | undefined,
): Args {
  const builder = BUILDERS[answers.tool];
  return builder ? builder(answers, observation) : {};
}

export function supportsArgs(tool: string): boolean {
  return tool in BUILDERS;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx vitest run tests/jev-args.test.ts`
Expected: PASS.

If `CraftArgs` requires an `amount` rather than `count`, or `AttackArgs` names its entity field
differently, read `src/tools/schemas.ts:114-190` and adjust the builder to the real field names —
the tests are the contract, the schema is the truth.

- [ ] **Step 5: Commit**

```bash
git add src/llm/jev-args.ts tests/jev-args.test.ts
git commit -m "feat(jev): deterministic argument builders per tool"
```

---

### Task 7: The provider itself

**Files:**
- Create: `src/llm/jev.ts`
- Test: `tests/jev.test.ts` (create)

**Interfaces:**
- Consumes: `JevConfig`, `LlmRequest`, `buildPayload`, `buildArguments`, `formatReason`,
  `formatRemember`, `LlmError` from `src/llm/provider.ts`, `scrubSecrets`/`tagged`.
- Produces: `JevProvider`, and re-exports `JevAnswers` from `jev-format.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/jev.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JevProvider } from '../src/llm/jev.js';
import { LlmError, type LlmRequest } from '../src/llm/provider.js';
import { testConfig } from './helpers/fixtures.js';
import type { JevConfig } from '../src/config/config.js';

function jevConfig(overrides: Partial<JevConfig> = {}): JevConfig {
  return { ...testConfig().jev, maxRetries: 0, requestTimeoutMs: 2_000, ...overrides };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'situation' },
    ],
    mode: 'json',
    tools: [
      { name: 'mine', description: 'Break a block.', parameters: {} },
      { name: 'observe', description: 'Look around.', parameters: {} },
    ],
    observation: { nearbyBlocks: [] } as never,
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
    urgency: { type: 'score', score: 'tense', probabilities: { calm: 0.2, tense: 0.7, critical: 0.1 }, confidence: 0.7 },
    goal_complete: { type: 'noul', noul: 0.02 },
    remember_worth: { type: 'noul', noul: 0.9 },
  },
};

describe('JevProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('reports no native tool calling', () => {
    expect(new JevProvider(jevConfig()).supportsToolCalling()).toBe(false);
  });

  it('posts to /systemone with the configured model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ANSWER));
    vi.stubGlobal('fetch', fetchMock);

    await new JevProvider(jevConfig()).complete(request());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/zen/v1/systemone');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).model).toBe('jev-1.13-free');
    expect(JSON.parse(init.body).questions.tool.type).toBe('choice');
    vi.unstubAllGlobals();
  });

  it('returns exactly one tool call built from the answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ANSWER)));

    const response = await new JevProvider(jevConfig()).complete(request());

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.name).toBe('mine');
    expect(JSON.parse(response.toolCalls[0]!.arguments)).toMatchObject({ collect: true });
    expect(response.content).toContain('p=0.7');
    vi.unstubAllGlobals();
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

    const response = await new JevProvider(jevConfig()).complete(request());
    expect(response.content).toContain('"goal_complete":true');
    vi.unstubAllGlobals();
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

    const response = await new JevProvider(jevConfig({ confidenceThreshold: 0.25 })).complete(request());
    expect(response.toolCalls).toHaveLength(1);
    expect(response.content).toContain('low confidence');
    vi.unstubAllGlobals();
  });

  it('fails loudly when the tool answer is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ model: 'jev-1.13-free', answers: {} })),
    );

    await expect(new JevProvider(jevConfig()).complete(request())).rejects.toThrow(LlmError);
    vi.unstubAllGlobals();
  });

  it('does not retry a 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new JevProvider(jevConfig()).complete(request())).rejects.toMatchObject({ code: 'AUTH' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('retries a 429 the configured number of times', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'slow down' } }, 429));
    vi.stubGlobal('fetch', fetchMock);

    const promise = new JevProvider(jevConfig({ maxRetries: 2 })).complete(request());
    const settled = promise.catch((err: LlmError) => err);
    await vi.runAllTimersAsync();
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it('scrubs the key out of error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { message: 'invalid key zen-abc123' } }, 403),
      ),
    );

    await expect(new JevProvider(jevConfig({ apiKey: 'zen-abc123' })).complete(request())).rejects.toThrow(
      /\[redacted\]/,
    );
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/jev.test.ts`
Expected: FAIL — `src/llm/jev.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/llm/jev.ts`:

```ts
import { scrubSecrets, tagged, type Logger } from '../utils/logger.js';
import type { JevConfig } from '../config/config.js';
import {
  LlmError,
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
} from './provider.js';
import { buildPayload } from './jev-questions.js';
import { buildArguments } from './jev-args.js';
import { formatReason, formatRemember, type JevAnswers } from './jev-format.js';

export type { JevAnswers } from './jev-format.js';

/* ────────────────────────── wire shapes ─────────────────────────────── */

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

        const base = error.code === 'RATE_LIMIT' ? 2_000 : 500;
        const delay = Math.min(base * 2 ** (attempt - 1), 15_000) + Math.random() * 250;
        this.log.warn({ attempt, of: attempts, code: error.code }, `jev request failed (${error.message}); retrying`);
        await sleep(delay, request.signal);
      }
    }

    /* c8 ignore next — the loop always returns or throws. */
    throw lastError ?? new LlmError('Jev request failed', 'NETWORK', false);
  }

  private async once(request: LlmRequest): Promise<LlmResponse> {
    const payload = buildPayload(request, this.cfg.model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;

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
      throw new LlmError(`response was not valid JSON: ${scrubSecrets(text.slice(0, 300))}`, 'BAD_RESPONSE', true);
    }
    if (parsed.error?.message) throw this.httpError(500, JSON.stringify(parsed));

    const answers = this.readAnswers(parsed);
    const args = buildArguments(answers, request.observation);

    const confidenceNote =
      (answers.toolProbabilities[answers.tool] ?? 0) < this.cfg.confidenceThreshold
        ? `low confidence (p=${(answers.toolProbabilities[answers.tool] ?? 0).toFixed(2)})`
        : null;

    const decision = {
      reason: formatReason(answers),
      tool: answers.tool,
      arguments: args,
      ...(answers.rememberWorth ? { remember: formatRemember(this.goalOf(request), answers) } : {}),
      goal_complete: answers.goalComplete,
    };

    this.log.debug({ tool: answers.tool, confidence: answers.toolConfidence }, 'jev decision');

    return {
      content: JSON.stringify(decision),
      toolCalls: [{ id: 'jev_0', name: answers.tool, arguments: JSON.stringify(args) }],
      model: parsed.model ?? this.model,
      finishReason: 'stop',
      latencyMs: Date.now() - startedAt,
    };
  }

  /** The agent's goal, as it appears in the system prompt; used for the memory note. */
  private goalOf(request: LlmRequest): string {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const match = /goal[^.]*?\bis\b[:\s]+(.+)/i.exec(system);
    return match?.[1]?.trim() ?? 'the current goal';
  }

  private readAnswers(parsed: WireResponse): JevAnswers {
    const answers = parsed.answers ?? {};
    const tool = answers['tool'];
    if (!tool?.choice) {
      throw new LlmError('jev response contained no tool answer', 'BAD_RESPONSE', true);
    }
    const urgency = answers['urgency'];
    const rubric = ['calm', 'tense', 'critical'] as const;
    const scored = rubric.includes(urgency?.score as (typeof rubric)[number])
      ? (urgency?.score as (typeof rubric)[number])
      : ('calm' as const);

    return {
      tool: tool.choice,
      toolProbabilities: tool.probabilities ?? { [tool.choice]: 1 },
      toolConfidence: tool.confidence ?? 1,
      target: answers['target']?.choice,
      urgency: scored,
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
    message = scrubSecrets(message);

    if (status === 401 || status === 403) return new LlmError(`authentication failed (${status}): ${message}`, 'AUTH', false, status);
    if (status === 429) return new LlmError(`rate limited: ${message}`, 'RATE_LIMIT', true, status);
    if (status === 400 || status === 404 || status === 422) return new LlmError(`request rejected (${status}): ${message}`, 'BAD_RESPONSE', false, status);
    return new LlmError(`jev error (${status}): ${message}`, 'SERVER', status >= 500, status);
  }

  private wrap(err: unknown): LlmError {
    if (err instanceof LlmError) return err;
    if (err instanceof Error && err.name === 'AbortError') return new LlmError('request aborted', 'ABORTED', false);
    const message = err instanceof Error ? err.message : String(err);
    return new LlmError(`network error: ${scrubSecrets(message)}`, 'NETWORK', true);
  }
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
```

Delete nothing — the `complete` loop calls the module-level `sleep(delay, request.signal)` directly, as
shown above.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npx vitest run tests/jev.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/jev.ts tests/jev.test.ts
git commit -m "feat(jev): System One decision provider"
```

---

### Task 8: Wire the provider in and document it

**Files:**
- Modify: `src/index.ts:11-13`, `src/index.ts:59`
- Modify: `.env`, `.env.example`, `docs/configuration.md`, `README.md`

**Interfaces:**
- Consumes: `JevProvider`, `Config.jev`, `Config.llm.provider`.
- Produces: `npm run start -- --llm-provider jev` working end to end.

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
it('builds a jev config that points at the System One endpoint', () => {
  const cfg = loadConfig({ ...MINIMAL_ENV, LLM_PROVIDER: 'jev' }, {}, true);
  expect(`${cfg.jev.baseUrl}/systemone`).toBe('https://opencode.ai/zen/v1/systemone');
  expect(cfg.llm.provider).toBe('jev');
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run tests/config.test.ts -t 'System One'`
Expected: FAIL — `cfg.llm.provider` is undefined.

- [ ] **Step 3: Implement**

In `src/index.ts`, add the import and replace line 59:

```ts
import { JevProvider } from './llm/jev.js';
```

```ts
  const provider: LLMProvider =
    control ??
    (cfg.llm.provider === 'jev'
      ? new JevProvider(cfg.jev, logger)
      : new OpenRouterProvider(cfg.llm, logger));
```

Line 137 currently prints `` `Model: ${cfg.llm.model}` ``; change it to read from the active provider so
a jev run reports its own model:

```ts
      cfg.control.enabled ? 'Driver: external control (no LLM)' : `Model: ${provider.model} via ${provider.name}`,
```

Append to `.env.example`, directly under the OpenRouter block:

```
# ─────────────────────────────────────────────────────────────
# OpenCode Zen — Jev 1.13 Free (structured decision model)
# ─────────────────────────────────────────────────────────────
# Jev is a System One model: it answers typed questions instead of
# generating text. Enable it with LLM_PROVIDER=jev and npm run build.
# Get a key at https://opencode.ai/auth. Free while the model is free.
# LLM_PROVIDER=openrouter
# JEV_API_KEY=
JEV_MODEL=jev-1.13-free
JEV_BASE_URL=https://opencode.ai/zen/v1
JEV_REQUEST_TIMEOUT_MS=30000
JEV_MAX_RETRIES=2
JEV_CONFIDENCE_THRESHOLD=0.25
```

Mirror the same block into `.env` with `JEV_API_KEY=` left empty (fall back to the existing
`OPENROUTER_API_KEY` if you prefer to keep one key file).

In `docs/configuration.md`, add a `## Jev (OpenCode Zen)` section covering the endpoint
(`/systemone`), the fact that arguments come from code rather than the model, the meaning of
`JEV_CONFIDENCE_THRESHOLD`, and that the free model costs nothing but is time-limited.

In `README.md`, add a short "Alternative provider" paragraph with the two commands:

```bash
LLM_PROVIDER=jev npm run start
npm run start -- --llm-provider jev
```

- [ ] **Step 4: Run everything**

Run: `npm run build && npm run typecheck && npm run test`
Expected: build succeeds and all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts .env.example docs/configuration.md README.md tests/config.test.ts
git commit -m "feat: select the jev provider from config and docs"
```

Do **not** stage `.env` — it holds real keys and is gitignored.

---

## Self-Review

**Spec coverage:** provider selection (Task 1, 8) · question payload (Task 5) · argument filling
(Task 4, 6) · reason/remember templates (Task 3) · error handling and retry (Task 7) · low-confidence
behaviour (Task 7) · configuration (Task 1, 8) · tests (every task) · docs (Task 8).

**Type consistency:** `JevAnswers` is defined in `jev-format.ts` and re-exported by `jev.ts`;
`jev-questions.ts` does not import it. `buildArguments(answers, observation)` matches its use in
`jev.ts`. `candidateTargets` returns block types consumed by `jev-args.ts` via `nearestGroup`.

**Resolved conflicts:** `AgentEvent` in `src/types.ts` is memory events, so the new provider types
are named `JevAnswers` / `JevPayload` and no clash occurs.

**Known deviation from the design doc:** `Agent` now sends `tools` on every request rather than only
in `tools` mode. This was required — `JevProvider` runs in `json` mode and would otherwise receive
no tool list. `OpenRouterProvider` gates on `mode` internally, so its behaviour is unchanged.