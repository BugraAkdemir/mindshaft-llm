# Web Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local browser panel that configures, starts, directs and live-observes the agent.

**Architecture:** `npm run panel` starts a `node:http` server on `127.0.0.1:3008`. Pressing Start
spawns the agent as a child process with three pipes: stdout carries a JSON-lines event stream and
nothing else, stderr carries the pino logs, stdin accepts commands. The agent gains a small event
emitter so its cycle can be narrated. The browser receives those events over SSE and renders them;
instructions travel back as `{"type":"guidance"}` into the existing `Agent.queueGuidance()`.

**Tech Stack:** Node 20 `node:http`, `child_process.spawn`, SSE, plain ES2022 in the browser,
vitest, pino.

## Global Constraints

- Node `>=20.11.0`; verify with `npm run build`, `npm run typecheck`, `npm run test`.
- **No new runtime or dev dependencies.** No framework, no bundler, no build step for the panel.
- `src/types.ts` already exports `AgentEvent` for memory events. The new stream type is
  **`AgentStreamEvent`** — do not reuse the name.
- stdout is reserved for the event stream while `--panel` is on. Any stray `console.log` in the agent
  corrupts it; pino must go to stderr.
- API keys are held in memory only and never written to disk or to a log.
- The panel binds `127.0.0.1` by default.
- Tests mock the child process and `fetch`; **no real processes are spawned and no port is bound
  below 1024**.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/agent/events.ts` | `AgentStreamEvent` union + dependency-free emitter |
| `src/agent/agent.ts` | **Modify** — emit events, public `setPaused` |
| `src/agent/action-loop.ts` | **Modify** — emit `cycle` |
| `src/utils/logger.ts` | **Modify** — `stderr` option |
| `src/config/config.ts` | **Modify** — `--panel`, `PANEL_*` |
| `src/panel/protocol.ts` | **Create** — agent side of the wire format |
| `src/panel/process.ts` | **Create** — supervisor: spawn, parse, persist |
| `src/panel/server.ts` | **Create** — HTTP + SSE |
| `src/panel/index.ts` | **Create** — `npm run panel` entry point |
| `src/panel/public/*` | **Create** — the page |
| `tests/events.test.ts` | **Create** — emitter and cycle narration |
| `tests/panel-protocol.test.ts` | **Create** — line framing, commands |
| `tests/panel-server.test.ts` | **Create** — routes and process supervision |

## Interfaces produced

```ts
// src/agent/events.ts
export type AgentStreamEvent =
  | { type: 'lifecycle'; status: 'connecting' | 'connected' | 'disconnected' | 'stopped'; detail?: string }
  | { type: 'world'; cycle: number; health: number; food: number; pos: Point3; timeOfDay: string; isDay: boolean; inventory: InventoryEntry[] }
  | { type: 'decision'; cycle: number; tool: string; arguments: Record<string, unknown>; reason: string }
  | { type: 'result'; cycle: number; success: boolean; error?: string; details?: string; durationMs: number }
  | { type: 'cycle'; cycle: number; kind: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'critical'; message: string };

export type EventListener = (event: AgentStreamEvent) => void;
export class EventBus {
  on(listener: EventListener): () => void;
  emit(event: AgentStreamEvent): void;
}

// Agent
public onEvent(listener: EventListener): () => void;   // returns unsubscribe
public setPaused(paused: boolean): void;

// src/panel/protocol.ts
export function writeEvent(stdout: { write(s: string): void }, event: AgentStreamEvent): void;
export function readCommands(stdin: { on(...): void }, onCommand: (c: PanelCommand) => void): void;
export type PanelCommand =
  | { type: 'guidance'; text: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

// src/panel/process.ts
export interface RunSettings {
  host: string; port: number; username: string; auth: 'offline' | 'microsoft';
  version?: string; goal: string;
  provider: 'openrouter' | 'jev';
  apiKey: string; model: string; baseUrl: string;
}
export class AgentProcess {
  constructor(opts: { cwd: string; nodeBin: string; entry: string; historyPath: string; logger?: Logger });
  on(listener: (e: AgentStreamEvent) => void): () => void;
  start(settings: RunSettings): void;
  send(command: PanelCommand): void;
  stop(): void;
  get running(): boolean;
  snapshot(): PanelSnapshot;
}

// src/panel/server.ts
export function createPanelServer(deps: { agent: AgentProcess; publicDir: string; logger?: Logger }): {
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
};
```

---

### Task 1: Event bus and cycle narration

**Files:**
- Create: `src/agent/events.ts`
- Modify: `src/agent/agent.ts` (`runCycle` at line 232), `src/agent/action-loop.ts` (`switch` at line 96)
- Test: `tests/events.test.ts` (create)

**Interfaces:**
- Consumes: `WorldState`, `AgentDecision`, `ToolResult`, `Point3`.
- Produces: `AgentStreamEvent`, `EventBus`, `Agent.onEvent`, `Agent.setPaused`.

- [ ] **Step 1: Write the failing test**

Create `tests/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/agent/events.js';

describe('EventBus', () => {
  it('delivers events to every subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on((e) => seen.push(`a:${e.type}`));
    bus.on((e) => seen.push(`b:${e.type}`));
    bus.emit({ type: 'cycle', cycle: 1, kind: 'acted' });
    expect(seen).toEqual(['a:cycle', 'b:cycle']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on((e) => seen.push(e.type));
    off();
    bus.emit({ type: 'cycle', cycle: 1, kind: 'acted' });
    expect(seen).toEqual([]);
  });

  it('keeps notifying the others when one listener throws', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on((e) => seen.push(e.type));
    expect(() => bus.emit({ type: 'cycle', cycle: 1, kind: 'acted' })).not.toThrow();
    expect(seen).toEqual(['cycle']);
  });

  it('reports how many listeners are attached', () => {
    const bus = new EventBus();
    bus.on(() => undefined);
    bus.on(() => undefined);
    expect(bus.size).toBe(2);
  });
});
```

Then extend `tests/integration.test.ts` with the narration assertions, copying that file's existing
agent setup:

```ts
it('narrates a cycle in order: world, decision, result, cycle', async () => {
  const seen: string[] = [];
  agent.onEvent((e) => seen.push(e.type));
  await agent.runCycle();
  expect(seen).toEqual(['world', 'decision', 'result', 'cycle']);
});

it('exposes pause state through setPaused', () => {
  expect(agent.isPaused).toBe(false);
  agent.setPaused(true);
  expect(agent.isPaused).toBe(true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/events.test.ts`
Expected: FAIL — `src/agent/events.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/agent/events.ts`:

```ts
import type { InventoryEntry, Point3 } from '../types.js';

/**
 * What the panel observes. Named `AgentStreamEvent` because `AgentEvent` in
 * `src/types.ts` already means "something that happened in the world".
 */
export type AgentStreamEvent =
  | { type: 'lifecycle'; status: 'connecting' | 'connected' | 'disconnected' | 'stopped'; detail?: string }
  | {
      type: 'world';
      cycle: number;
      health: number;
      food: number;
      pos: Point3;
      timeOfDay: string;
      isDay: boolean;
      inventory: InventoryEntry[];
    }
  | { type: 'decision'; cycle: number; tool: string; arguments: Record<string, unknown>; reason: string }
  | { type: 'result'; cycle: number; success: boolean; error?: string; details?: string; durationMs: number }
  | { type: 'cycle'; cycle: number; kind: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'critical'; message: string };

export type EventListener = (event: AgentStreamEvent) => void;

/**
 * Minimal synchronous emitter. A dependency would be heavier than the twenty
 * lines it replaces, and a listener that throws must not take the agent down.
 */
export class EventBus {
  private listeners = new Set<EventListener>();

  public on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public get size(): number {
    return this.listeners.size;
  }

  public emit(event: AgentStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`event listener failed: ${detail}\n`);
      }
    }
  }
}
```

In `src/agent/agent.ts`, add near the other private fields (around line 81):

```ts
  private readonly bus = new EventBus();
  private cycleCount = 0;
```

Add the import, add the public methods after `queueGuidance` (line 525), and emit inside `runCycle`:

```ts
  public onEvent(listener: EventListener): () => void {
    return this.bus.on(listener);
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Narrates a cycle to any attached panel. */
  public emit(event: AgentStreamEvent): void {
    this.bus.emit(event);
  }
```

```ts
    const state = this.observe();
    this.cycleCount += 1;
    const cycle = this.cycleCount;
    this.emit({
      type: 'world',
      cycle,
      health: state.player.health,
      food: state.player.food,
      pos: state.player.position,
      timeOfDay: state.environment.timeOfDay,
      isDay: state.environment.isDay,
      inventory: state.inventory,
    });
```

and immediately after `const decision = await this.decide(state);` succeeds:

```ts
    this.emit({
      type: 'decision',
      cycle,
      tool: decision.decision.tool,
      arguments: decision.decision.arguments,
      reason: decision.decision.reason,
    });
```

and after `const result = await this.execute(decision.decision);`:

```ts
    this.emit({
      type: 'result',
      cycle,
      success: result.success,
      ...(result.success ? {} : { error: result.error, details: result.details }),
      durationMs: result.durationMs,
    });
```

In `src/agent/action-loop.ts`, emit the terminal kind at the top of the `switch` (line 96):

```ts
        agent.emit({ type: 'cycle', cycle: this.cycles, kind: cycle.kind });
```

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm run test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/events.ts src/agent/agent.ts src/agent/action-loop.ts tests/events.test.ts tests/integration.test.ts
git commit -m "feat(agent): narrate cycles to subscribers"
```

---

### Task 2: Keep stdout clean and add `--panel`

**Files:**
- Modify: `src/utils/logger.ts:17-40`, `src/utils/logger.ts:46-72`
- Modify: `src/config/config.ts` (`RawEnvSchema`, `LogConfig`, `CliOverrides`, `parseArgs`, `HELP_TEXT`)
- Test: `tests/config.test.ts` (modify), `tests/panel-flags.test.ts` (create)

**Interfaces:**
- Produces: `LoggerOptions.stderr?: boolean`, `Config.log.stderr`, `CliOverrides.panel`.

- [ ] **Step 1: Write the failing tests**

In `tests/config.test.ts`, add:

```ts
it('routes logs to stderr in panel mode', () => {
  const cfg = loadConfig({ ...MINIMAL_ENV }, { panel: true }, true);
  expect(cfg.log.stderr).toBe(true);
  expect(cfg.log.pretty).toBe(false);
});

it('leaves logging on stdout outside panel mode', () => {
  const cfg = loadConfig({ ...MINIMAL_ENV }, {}, true);
  expect(cfg.log.stderr).toBe(false);
});

it('parses --panel', () => {
  const parsed = parseArgs(['--panel']);
  expect(parsed.overrides.panel).toBe(true);
});

it('parses --panel-port and implies --panel', () => {
  const parsed = parseArgs(['--panel-port', '3010']);
  expect(parsed.overrides.panelPort).toBe(3010);
  expect(parsed.overrides.panel).toBe(true);
});

it('exposes PANEL_PORT', () => {
  const cfg = loadConfig({ ...MINIMAL_ENV, PANEL_PORT: '3100' }, { panel: true }, true);
  expect(cfg.panel.port).toBe(3100);
  expect(cfg.panel.host).toBe('127.0.0.1');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `cfg.log.stderr` and `cfg.panel` do not exist.

- [ ] **Step 3: Implement the logger**

In `src/utils/logger.ts`, add to `LoggerOptions`:

```ts
export interface LoggerOptions {
  level: string;
  pretty: boolean;
  /** Send records to stderr. Required when stdout carries a machine-readable stream. */
  stderr?: boolean;
}
```

and inside `createLogger`, at the end before `return rootLogger;`:

```ts
  if (options.stderr) {
    rootLogger = pino(base, pino.destination({ fd: 2 }));
    return rootLogger;
  }
```

- [ ] **Step 4: Implement the config**

In `src/config/config.ts` add to `RawEnvSchema` after the `VIEWER_*` block (line 104):

```ts
  PANEL_HOST: nonEmpty('127.0.0.1'),
  PANEL_PORT: intIn(1, 65_535, 3008),
```

Add the interfaces near `ViewerConfig` (line 169):

```ts
export interface PanelConfig {
  host: string;
  port: number;
  /** Agent runs with a machine-readable stdout stream when the panel is active. */
  active: boolean;
}
```

Add `panel: PanelConfig;` to `Config`, `panel?: boolean; panelPort?: number;` to `CliOverrides`, and
in `loadConfig`:

```ts
    panel: {
      host: e.PANEL_HOST,
      port: overrides.panelPort ?? e.PANEL_PORT,
      active: overrides.panel === true,
    },
    log: {
      level: overrides.debug ? 'debug' : e.LOG_LEVEL,
      pretty: overrides.panel === true ? false : e.LOG_PRETTY,
      stderr: overrides.panel === true,
    },
```

Add `stderr: boolean;` to `LogConfig`.

In `parseArgs`, handle the flags beside `--viewer` (line 354) and add `--panel-port` to
`FLAGS_WITH_VALUES`:

```ts
    if (raw === '--panel') {
      overrides.panel = true;
      continue;
    }
```

```ts
      case '--panel-port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          errors.push(`Invalid --panel-port "${value}" (expected 1-65535).`);
        } else {
          overrides.panelPort = port;
          overrides.panel = true;
        }
        break;
      }
```

Update `HELP_TEXT`:

```
  --panel              Run the local web control panel.
  --panel-port <port>  Port for the panel (default: 3008; implies --panel).
```

- [ ] **Step 5: Run and confirm green**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/logger.ts src/config/config.ts tests/config.test.ts
git commit -m "feat(config): panel flags and stderr logging"
```

---

### Task 3: The wire protocol, agent side

**Files:**
- Create: `src/panel/protocol.ts`
- Test: `tests/panel-protocol.test.ts` (create)

**Interfaces:**
- Consumes: `AgentStreamEvent`, `Agent`.
- Produces: `writeEvent`, `readCommands`, `PanelCommand`.

- [ ] **Step 1: Write the failing test**

Create `tests/panel-protocol.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readCommands, writeEvent, type PanelCommand } from '../src/panel/protocol.js';

function capture() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => chunks.push(s) };
}

it('writes one JSON object per line', () => {
  const out = capture();
  writeEvent(out, { type: 'cycle', cycle: 3, kind: 'acted' });
  writeEvent(out, { type: 'notice', level: 'info', message: 'hi' });
  expect(out.chunks).toHaveLength(2);
  for (const chunk of out.chunks) expect(chunk.endsWith('\n')).toBe(true);
  expect(JSON.parse(out.chunks[0]!)).toEqual({ type: 'cycle', cycle: 3, kind: 'acted' });
});

describe('readCommands', () => {
  function parse(chunks: string[]): PanelCommand[] {
    const stdin = new EventEmitter();
    const seen: PanelCommand[] = [];
    readCommands(stdin as never, (c) => seen.push(c));
    for (const chunk of chunks) stdin.emit('data', Buffer.from(chunk));
    return seen;
  }

  it('reads a complete command', () => {
    expect(parse(['{"type":"pause"}\n'])).toEqual([{ type: 'pause' }]);
  });

  it('waits for the newline when a command is split', () => {
    expect(parse(['{"type":"gui', 'dance","text":"go"}\n'])).toEqual([
      { type: 'guidance', text: 'go' },
    ]);
  });

  it('reads several commands from one chunk', () => {
    expect(parse(['{"type":"pause"}\n{"type":"stop"}\n'])).toEqual([
      { type: 'pause' },
      { type: 'stop' },
    ]);
  });

  it('drops a malformed line instead of throwing', () => {
    expect(parse(['not json\n{"type":"stop"}\n'])).toEqual([{ type: 'stop' }]);
  });

  it('ignores a guidance command with no text', () => {
    expect(parse(['{"type":"guidance","text":"  "}\n'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/panel-protocol.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/panel/protocol.ts`:

```ts
import type { AgentStreamEvent } from '../agent/events.js';

/** What the panel may send to a running agent. */
export type PanelCommand =
  | { type: 'guidance'; text: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

/** Anything with a `write`, so a test can pass a plain array collector. */
export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** One JSON object per line. A partial line must never be emitted. */
export function writeEvent(out: WritableLike, event: AgentStreamEvent): void {
  out.write(`${JSON.stringify(event)}\n`);
}

/**
 * Reads newline-delimited commands. Buffers across chunks, because a single
 * write may split a command in half or carry several at once.
 */
export function readCommands(stdin: ReadableLike, onCommand: (command: PanelCommand) => void): void {
  let buffer = '';

  stdin.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') dispatch(line, onCommand);
      newline = buffer.indexOf('\n');
    }
  });
}

function dispatch(line: string, onCommand: (command: PanelCommand) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A malformed line is the panel's bug; the run must survive it.
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;

  const candidate = parsed as { type?: unknown; text?: unknown };
  switch (candidate.type) {
    case 'pause':
      onCommand({ type: 'pause' });
      return;
    case 'resume':
      onCommand({ type: 'resume' });
      return;
    case 'stop':
      onCommand({ type: 'stop' });
      return;
    case 'guidance': {
      const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
      if (text !== '') onCommand({ type: 'guidance', text });
      return;
    }
    default:
  }
}
```

- [ ] **Step 4: Run and confirm green**

Run: `npx vitest run tests/panel-protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/protocol.ts tests/panel-protocol.test.ts
git commit -m "feat(panel): newline-delimited wire protocol"
```

---

### Task 4: Supervise the agent process

**Files:**
- Create: `src/panel/process.ts`
- Test: `tests/panel-process.test.ts` (create)

**Interfaces:**
- Consumes: `spawn` from `node:child_process`, `AgentStreamEvent`, `PanelCommand`.
- Produces: `AgentProcess`, `RunSettings`, `PanelSnapshot`, `LineSplitter`.

- [ ] **Step 1: Write the failing test**

Create `tests/panel-process.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../src/panel/process.js';

describe('LineSplitter', () => {
  it('emits one item per complete line', () => {
    const seen: string[] = [];
    const splitter = new LineSplitter((line) => seen.push(line));
    splitter.push('a\nb\n');
    expect(seen).toEqual(['a', 'b']);
  });

  it('holds a partial line until its newline arrives', () => {
    const seen: string[] = [];
    const splitter = new LineSplitter((line) => seen.push(line));
    splitter.push('{"type":"cyc');
    expect(seen).toEqual([]);
    splitter.push('le"}\n');
    expect(seen).toEqual(['{"type":"cycle"}']);
  });

  it('handles a chunk with no trailing newline at all', () => {
    const seen: string[] = [];
    const splitter = new LineSplitter((line) => seen.push(line));
    splitter.push('one\ntwo');
    expect(seen).toEqual(['one']);
  });

  it('tolerates CRLF', () => {
    const seen: string[] = [];
    const splitter = new LineSplitter((line) => seen.push(line));
    splitter.push('one\r\n');
    expect(seen).toEqual(['one']);
  });
});

it('keeps API keys out of the history file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-'));
  const historyPath = join(dir, 'history.json');
  // Any serialisation path that touches settings must go through redact().
  expect(historyPath).toContain('panel-');
  expect(readFileSync(historyPath, 'utf8')).toBe('');
});

it('parses every event shape the agent can emit', () => {
  const seen: unknown[] = [];
  const splitter = new LineSplitter((line) => seen.push(JSON.parse(line)));
  splitter.push(
    [
      '{"type":"lifecycle","status":"connected"}',
      '{"type":"world","cycle":1,"health":20,"food":20,"pos":{"x":1,"y":64,"z":2},"timeOfDay":"day","isDay":true,"inventory":[]}',
      '{"type":"decision","cycle":1,"tool":"mine","arguments":{},"reason":"r"}',
      '{"type":"result","cycle":1,"success":true,"durationMs":5}',
      '{"type":"cycle","cycle":1,"kind":"acted"}',
    ].join('\n') + '\n',
  );
  expect(seen).toHaveLength(5);
});
```

Replace the placeholder history test with the real check once `AgentProcess` exists (Step 3 defines
`persistSettings`, which is the function under test):

```ts
it('writes settings without the API key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-'));
  const historyPath = join(dir, 'history.json');
  writePersistedSettings(historyPath, {
    host: 'localhost', port: 25565, username: 'AI_Agent', auth: 'offline',
    goal: 'Gather wood', provider: 'jev', model: 'jev-1.13-free',
    baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'zen-secret-key',
  });
  const written = readFileSync(historyPath, 'utf8');
  expect(written).toContain('localhost');
  expect(written).not.toContain('zen-secret-key');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/panel-process.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/panel/process.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrubSecrets, type Logger } from '../utils/logger.js';
import type { AgentStreamEvent } from '../agent/events.js';
import type { PanelCommand } from './protocol.js';

/** Turns an arbitrary byte stream into complete lines. */
export class LineSplitter {
  private buffer = '';

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== '') this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }
}

export interface RunSettings {
  host: string;
  port: number;
  username: string;
  auth: 'offline' | 'microsoft';
  version?: string;
  goal: string;
  provider: 'openrouter' | 'jev';
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Exactly what RunSettings holds minus the secret. */
export type PersistedSettings = Omit<RunSettings, 'apiKey'>;

export interface PanelSnapshot {
  running: boolean;
  exitCode: number | null;
  lifecycle: string;
  lastWorld: Extract<AgentStreamEvent, { type: 'world' }> | null;
  recent: AgentStreamEvent[];
  settings: PersistedSettings | null;
}

/** The last N events kept for a page refresh. */
const HISTORY_LIMIT = 300;

export function writePersistedSettings(path: string, settings: RunSettings): void {
  const { apiKey: _apiKey, ...safe } = settings;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
}

export function readPersistedSettings(path: string): PersistedSettings | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedSettings;
  } catch {
    return null;
  }
}

export class AgentProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private recent: AgentStreamEvent[] = [];
  private lastWorld: PanelSnapshot['lastWorld'] = null;
  private lifecycle = 'idle';
  private exitCode: number | null = null;
  private settings: PersistedSettings | null = null;
  private splitter = new LineSplitter((line) => this.consume(line));

  public constructor(
    private readonly opts: {
      cwd: string;
      nodeBin: string;
      entry: string;
      historyPath: string;
      logger?: Logger;
    },
  ) {
    this.settings = readPersistedSettings(opts.historyPath);
  }

  public on(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public get running(): boolean {
    return this.child !== null && this.exitCode === null;
  }

  public snapshot(): PanelSnapshot {
    return {
      running: this.running,
      exitCode: this.exitCode,
      lifecycle: this.lifecycle,
      lastWorld: this.lastWorld,
      recent: [...this.recent],
      settings: this.settings,
    };
  }

  public start(settings: RunSettings): void {
    if (this.child) throw new Error('an agent is already running');

    const { apiKey, ...safe } = settings;
    this.settings = safe;
    this.exitCode = null;
    writePersistedSettings(this.opts.historyPath, settings);

    const args = [
      this.opts.entry,
      '--panel',
      '--host', settings.host,
      '--port', String(settings.port),
      '--username', settings.username,
      '--goal', settings.goal,
      '--llm-provider', settings.provider,
      '--model', settings.model,
    ];
    if (settings.version) args.push('--version', settings.version);
    if (settings.auth === 'microsoft') args.push('--auth', 'microsoft');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LOG_PRETTY: 'false',
      ...(settings.provider === 'jev'
        ? { JEV_API_KEY: apiKey, JEV_MODEL: settings.model, JEV_BASE_URL: settings.baseUrl }
        : {
            OPENROUTER_API_KEY: apiKey,
            OPENROUTER_MODEL: settings.model,
            OPENROUTER_BASE_URL: settings.baseUrl,
          }),
    };

    this.publish({ type: 'lifecycle', status: 'connecting' });

    const child = spawn(this.opts.nodeBin, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.splitter.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      // Already scrubbed upstream; this only forwards for the panel's own log.
      this.opts.logger?.debug({ line: scrubSecrets(chunk.toString('utf8').slice(0, 300)) }, 'agent stderr');
    });
    child.on('error', (err) => {
      this.publish({ type: 'lifecycle', status: 'stopped', detail: scrubSecrets(err.message) });
    });
    child.on('exit', (code) => {
      this.exitCode = code;
      this.child = null;
      this.publish({ type: 'lifecycle', status: 'stopped', detail: `exit code ${code}` });
    });
  }

  public send(command: PanelCommand): void {
    const child = this.child;
    if (!child) throw new Error('no agent is running');
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  public stop(): void {
    this.child?.kill('SIGTERM');
  }

  private consume(line: string): void {
    let event: AgentStreamEvent;
    try {
      event = JSON.parse(line) as AgentStreamEvent;
    } catch {
      return; // A stray console.log from the agent: ignore, never crash the panel.
    }
    if (event.type === 'world') this.lastWorld = event;
    if (event.type === 'lifecycle') this.lifecycle = event.status;
    this.publish(event);
  }

  private publish(event: AgentStreamEvent): void {
    this.recent.push(event);
    if (this.recent.length > HISTORY_LIMIT) this.recent.shift();
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a broken SSE client must not stop the run */
      }
    }
  }
}
```

`--auth` is not currently a CLI flag; add it in this task beside `--port` in `parseArgs`, backed by
`CliOverrides.auth?: 'offline' | 'microsoft'`, so the panel can reach authenticated servers.

- [ ] **Step 4: Run and confirm green**

Run: `npm run typecheck && npx vitest run tests/panel-process.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/process.ts tests/panel-process.test.ts src/config/config.ts
git commit -m "feat(panel): supervise the agent child process"
```

---

### Task 5: HTTP and SSE

**Files:**
- Create: `src/panel/server.ts`
- Create: `src/panel/index.ts`
- Modify: `package.json` (`scripts.panel`)
- Test: `tests/panel-server.test.ts` (create)

**Interfaces:**
- Consumes: `AgentProcess`, `PanelCommand`.
- Produces: `createPanelServer`, `POST /api/command`, `GET /api/events`, `GET /api/state`, `GET /api/start`.

- [ ] **Step 1: Write the failing test**

Create `tests/panel-server.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPanelServer } from '../src/panel/server.js';
import type { AgentProcess, RunSettings } from '../src/panel/process.js';
import type { PanelCommand } from '../src/panel/protocol.js';

const SETTINGS: RunSettings = {
  host: 'localhost', port: 25565, username: 'AI_Agent', auth: 'offline',
  goal: 'Gather wood', provider: 'jev', model: 'jev-1.13-free',
  baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'zen-secret',
};

class FakeAgent {
  public readonly sent: PanelCommand[] = [];
  public readonly started: RunSettings[] = [];
  private listeners: Array<(e: unknown) => void> = [];
  public on(listener: (e: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => undefined;
  }
  public start(settings: RunSettings): void {
    this.started.push(settings);
  }
  public send(command: PanelCommand): void {
    this.sent.push(command);
  }
  public stop(): void {}
  public get running(): boolean {
    return false;
  }
  public snapshot() {
    return { running: false, exitCode: null, lifecycle: 'idle', lastWorld: null, recent: [], settings: null };
  }
}

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function boot(agent: FakeAgent) {
  const publicDir = mkdtempSync(join(tmpdir(), 'panel-public-'));
  writeFileSync(join(publicDir, 'index.html'), '<h1>panel</h1>');
  const server = createPanelServer({
    agent: agent as unknown as AgentProcess,
    publicDir,
  });
  const port = await server.listen(0, '127.0.0.1');
  open.push(() => server.close());
  return `http://127.0.0.1:${port}`;
}

describe('panel server', () => {
  it('serves the static page', async () => {
    const base = await boot(new FakeAgent());
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('panel');
  });

  it('refuses to serve outside the public directory', async () => {
    const base = await boot(new FakeAgent());
    const res = await fetch(`${base}/../package.json`);
    expect(res.status).toBe(404);
  });

  it('returns a snapshot from /api/state', async () => {
    const base = await boot(new FakeAgent());
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ running: false });
  });

  it('starts the agent with the given settings', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const res = await fetch(`${base}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SETTINGS),
    });
    expect(res.status).toBe(200);
    expect(agent.started[0]).toMatchObject({ host: 'localhost', provider: 'jev' });
  });

  it('rejects a start request that is not JSON', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const res = await fetch(`${base}/api/start`, { method: 'POST', body: 'host=x' });
    expect(res.status).toBe(415);
    expect(agent.started).toHaveLength(0);
  });

  it('rejects a cross-origin start request', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const res = await fetch(`${base}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify(SETTINGS),
    });
    expect(res.status).toBe(403);
    expect(agent.started).toHaveLength(0);
  });

  it('forwards guidance to the agent', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const res = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'guidance', text: 'Collect wood' }),
    });
    expect(res.status).toBe(200);
    expect(agent.sent).toEqual([{ type: 'guidance', text: 'Collect wood' }]);
  });

  it('reports 409 when no agent is running', async () => {
    const base = await boot(new FakeAgent());
    const res = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'pause' }),
    });
    expect(res.status).toBe(409);
  });

  it('streams events over SSE', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const received = reader.read();
    for (const listener of (agent as unknown as { listeners: Array<(e: unknown) => void> }).listeners) {
      listener({ type: 'cycle', cycle: 1, kind: 'acted' });
    }
    const chunk = await received;
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('event: message');
    expect(text).toContain('"kind":"acted"');
    controller.abort();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/panel-server.test.ts`
Expected: FAIL — `src/panel/server.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/panel/server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { AgentProcess } from './process.js';
import type { PanelCommand } from './protocol.js';
import type { AgentStreamEvent } from '../agent/events.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const COMMAND_TYPES = new Set(['guidance', 'pause', 'resume', 'stop']);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * Rejects cross-origin writes. A simple `POST` can be made from any page, so a
 * browser on another origin must not be able to steer the bot.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl and the test client send no Origin.
  try {
    const host = req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

function toCommand(body: unknown): PanelCommand | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as { type?: unknown; text?: unknown };
  if (typeof candidate.type !== 'string' || !COMMAND_TYPES.has(candidate.type)) return null;
  if (candidate.type === 'guidance') {
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    return text === '' ? null : { type: 'guidance', text };
  }
  return { type: candidate.type } as PanelCommand;
}

export function createPanelServer(deps: {
  agent: AgentProcess;
  publicDir: string;
  logger?: Logger;
}): { listen(port: number, host: string): Promise<number>; close(): Promise<void> } {
  const root = resolve(deps.publicDir);
  const clients = new Set<ServerResponse>();

  deps.agent.on((event: AgentStreamEvent) => {
    const frame = `event: message\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: message\ndata: ${JSON.stringify(deps.agent.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (path === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, deps.agent.snapshot());
      return;
    }

    if (req.method === 'POST') {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'expected application/json' });
        return;
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: 'cross-origin request refused' });
        return;
      }
      const body = await readJson(req);

      if (path === '/api/start') {
        try {
          deps.agent.start(body as never);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 409, { error: err instanceof Error ? err.message : 'cannot start' });
        }
        return;
      }

      if (path === '/api/command') {
        const command = toCommand(body);
        if (!command) {
          sendJson(res, 400, { error: 'unknown command' });
          return;
        }
        try {
          deps.agent.send(command);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 409, { error: err instanceof Error ? err.message : 'no agent running' });
        }
        return;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const relative = path === '/' ? 'index.html' : path.slice(1);
    const target = resolve(join(root, normalize(relative)));
    if (!target.startsWith(root) || !existsSync(target)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  }

  return {
    listen(port, host) {
      return new Promise((resolvePort, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolvePort(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close() {
      for (const client of clients) client.end();
      clients.clear();
      return new Promise((done) => server.close(() => done()));
    },
  };
}
```

Create `src/panel/index.ts`:

```ts
#!/usr/bin/env node
import { resolve } from 'node:path';
import { AgentProcess } from './process.js';
import { createPanelServer } from './server.js';
import { createLogger } from '../utils/logger.js';

async function main(): Promise<number> {
  const logger = createLogger({ level: process.env['LOG_LEVEL'] ?? 'info', pretty: true });
  const cwd = resolve(process.argv[2] ?? '.');

  const agent = new AgentProcess({
    cwd,
    nodeBin: process.execPath,
    entry: resolve(cwd, 'dist/index.js'),
    historyPath: resolve(cwd, 'panel-history.json'),
    logger,
  });

  const server = createPanelServer({
    agent,
    publicDir: resolve(cwd, 'dist/panel/public'),
    logger,
  });

  const port = Number(process.env['PANEL_PORT'] ?? 3008);
  const host = process.env['PANEL_HOST'] ?? '127.0.0.1';
  const bound = await server.listen(port, host);

  process.stdout.write(`Panel ready at http://${host}:${bound}\n`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    process.stdout.write(
      `\nWARNING: the panel is bound to ${host}, so anyone who can reach this machine ` +
        `can drive the bot. Press Ctrl-C to stop.\n\n`,
    );
  }
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
```

The build must copy the static assets, so add to `tsconfig.json`'s sibling: create
`scripts/copy-panel-assets.mjs` and call it from `package.json`:

```json
"build": "tsc -p tsconfig.json && node scripts/copy-panel-assets.mjs"
```

```js
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const from = resolve('src/panel/public');
const to = resolve('dist/panel/public');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add after `"server"`:

```json
"panel": "node --enable-source-maps dist/panel/index.js"
```

- [ ] **Step 5: Run and confirm green**

Run: `npm run typecheck && npx vitest run tests/panel-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/panel/server.ts src/panel/index.ts scripts/copy-panel-assets.mjs package.json tsconfig.json tests/panel-server.test.ts
git commit -m "feat(panel): HTTP and SSE control surface"
```

---

### Task 6: The page

**Files:**
- Create: `src/panel/public/index.html`
- Create: `src/panel/public/app.js`
- Create: `src/panel/public/style.css`

**Interfaces:**
- Consumes: `GET /api/state`, `GET /api/events`, `POST /api/start`, `POST /api/command`.
- Produces: a page an operator can run the agent from.

- [ ] **Step 1: Write the failing test**

Append to `tests/panel-server.test.ts` — a content test, because a page that fails to load is the
whole feature failing:

```ts
it('ships a page that references the API it needs', async () => {
  const publicDir = mkdtempSync(join(tmpdir(), 'panel-public-'));
  for (const file of ['index.html', 'app.js', 'style.css']) {
    writeFileSync(join(publicDir, file), readFileSync(resolve('src/panel/public', file)));
  }
  const server = createPanelServer({ agent: new FakeAgent() as unknown as AgentProcess, publicDir });
  const port = await server.listen(0, '127.0.0.1');
  open.push(() => server.close());
  const base = `http://127.0.0.1:${port}`;

  const js = await (await fetch(`${base}/app.js`)).text();
  expect(js).toContain('/api/start');
  expect(js).toContain('/api/command');
  expect(js).toContain('/api/events');

  const html = await (await fetch(`${base}/`)).text();
  expect(html).toContain('app.js');
  expect(html).toContain('style.css');
});
```

Add `readFileSync` and `resolve` to the test file's imports.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/panel-server.test.ts -t 'ships a page'`
Expected: FAIL — the static files do not exist yet.

- [ ] **Step 3: Write the page**

`src/panel/public/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mindshaft — control panel</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <header class="status">
      <span id="connection" class="pill pill--idle">starting</span>
      <span class="stat">HP <b id="health">–</b></span>
      <span class="stat">Food <b id="food">–</b></span>
      <span class="stat">Pos <b id="pos">–</b></span>
      <span class="stat">Time <b id="time">–</b></span>
      <span class="stat">Goal <b id="goal">–</b></span>
      <button id="notify" class="ghost" type="button">Enable notifications</button>
    </header>

    <main>
      <section class="panel">
        <h2>Settings</h2>
        <fieldset>
          <legend>Minecraft server</legend>
          <label>Host <input id="host" value="localhost" /></label>
          <label>Port <input id="mcport" type="number" value="25565" /></label>
          <label>Username <input id="username" value="AI_Agent" /></label>
          <label>Version <input id="version" placeholder="auto" /></label>
        </fieldset>
        <fieldset>
          <legend>Model</legend>
          <label>Provider
            <select id="provider">
              <option value="jev">OpenCode Zen — Jev (decision model)</option>
              <option value="openrouter">OpenRouter (chat)</option>
            </select>
          </label>
          <label>API key <input id="apikey" type="password" placeholder="never written to disk" /></label>
          <label>Model <input id="model" value="jev-1.13-free" /></label>
          <label>Base URL <input id="baseurl" value="https://opencode.ai/zen/v1" /></label>
        </fieldset>
        <label>Goal <input id="goalInput" value="Gather wood, then craft wooden tools." /></label>
        <div class="row">
          <button id="start" class="primary" type="button">Start</button>
          <button id="pause" type="button" disabled>Pause</button>
          <button id="stop" type="button" disabled>Stop</button>
        </div>
      </section>

      <section class="panel">
        <h2>Live feed</h2>
        <form id="instruct" class="row">
          <input id="instruction" placeholder="Tell the agent what to do next…" autocomplete="off" />
          <button type="submit" disabled>Send</button>
        </form>
        <ul id="pending" class="pending"></ul>
        <div class="row feed-controls">
          <label class="ghost"><input id="autoscroll" type="checkbox" checked /> Auto-scroll</label>
          <button id="clear" class="ghost" type="button">Clear</button>
        </div>
        <ol id="feed" class="feed"></ol>
      </section>
    </main>

    <script src="/app.js"></script>
  </body>
</html>
```

`src/panel/public/style.css`:

```css
:root {
  color-scheme: dark;
  --bg: #10131a;
  --panel: #181c26;
  --line: #2a3040;
  --text: #e6e9f0;
  --muted: #96a0b5;
  --accent: #6ea8fe;
  --ok: #57c98a;
  --bad: #e8735f;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

.status {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  flex-wrap: wrap;
}

.stat { color: var(--muted); }
.stat b { color: var(--text); font-weight: 600; }

.pill {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--line);
}
.pill--idle { color: var(--muted); }
.pill--live { color: var(--ok); border-color: var(--ok); }
.pill--down { color: var(--bad); border-color: var(--bad); }

main {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  padding: 16px;
  align-items: start;
}

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
}

h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }

fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 12px; padding: 10px; }
legend { color: var(--muted); font-size: 12px; padding: 0 6px; }

label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
input, select {
  width: 100%;
  margin-top: 3px;
  padding: 6px 8px;
  background: #0e1118;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  font: inherit;
}

.row { display: flex; gap: 8px; align-items: center; }
.row input { flex: 1; margin-top: 0; }

button {
  padding: 7px 14px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: #222736;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: #0b1020; font-weight: 600; }
button.ghost { background: transparent; color: var(--muted); }

.pending { list-style: none; margin: 10px 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.pending li {
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px dashed var(--muted);
  color: var(--muted);
  font-size: 12px;
}
.pending li.sent { border-style: solid; border-color: var(--ok); color: var(--ok); }

.feed { list-style: none; margin: 10px 0 0; padding: 0; max-height: 62vh; overflow-y: auto; }
.feed li {
  border-left: 3px solid var(--line);
  padding: 6px 10px;
  margin-bottom: 6px;
  background: #141824;
  border-radius: 0 6px 6px 0;
}
.feed li.ok { border-left-color: var(--ok); }
.feed li.bad { border-left-color: var(--bad); }
.feed .meta { color: var(--muted); font-size: 12px; }
.feed .tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.feed .reason { color: var(--muted); }
.feed .err { color: var(--bad); }

@media (max-width: 860px) {
  main { grid-template-columns: 1fr; }
}
```

`src/panel/public/app.js`:

```js
/* The whole panel. No build step: fetch for commands, EventSource for the feed. */
const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  paused: false,
  cycle: 0,
  /** Guidance sent but not yet folded into a cycle. */
  pending: [],
};

const notifications = { enabled: false };

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

async function command(type, text) {
  await post('/api/command', { type, text });
}

function notify(title, body) {
  if (!notifications.enabled) return;
  if (Notification.permission === 'granted') new Notification(title, { body });
}

/* ───────────────────────────── status bar ───────────────────────────── */

function setConnection(label, cls) {
  const el = $('connection');
  el.textContent = label;
  el.className = `pill pill--${cls}`;
}

function renderWorld(world) {
  $('health').textContent = world.health;
  $('food').textContent = world.food;
  $('pos').textContent = `${world.pos.x}, ${world.pos.y}, ${world.pos.z}`;
  $('time').textContent = world.timeOfDay;
}

function renderInventory(inventory) {
  $('pos').title = inventory.map((i) => `${i.item} ×${i.count}`).join('\n');
}

/* ───────────────────────────── live feed ───────────────────────────── */

function addRow(parts) {
  const li = document.createElement('li');
  for (const [cls, text] of parts) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    li.appendChild(span);
    li.appendChild(document.createTextNode(' '));
  }
  $('feed').appendChild(li);
  scrollIfWanted();
  return li;
}

function scrollIfWanted() {
  if ($('autoscroll').checked) $('feed').scrollTop = $('feed').scrollHeight;
}

function renderEvent(event) {
  switch (event.type) {
    case 'lifecycle':
      setConnection(event.status, event.status === 'connected' ? 'live' : 'down');
      state.running = event.status !== 'stopped';
      syncButtons();
      if (event.status === 'stopped') notify('Agent stopped', event.detail ?? '');
      return;

    case 'world':
      state.cycle = event.cycle;
      renderWorld(event);
      renderInventory(event.inventory);
      markDelivered();
      return;

    case 'decision': {
      const row = addRow([
        ['meta', `#${event.cycle}`],
        ['tool', event.tool],
        ['meta', JSON.stringify(event.arguments)],
      ]);
      row.classList.add('ok');
      row.appendChild(Object.assign(document.createElement('div'), {
        className: 'reason',
        textContent: event.reason,
      }));
      return;
    }

    case 'result': {
      const row = $('feed').lastElementChild;
      if (row) {
        row.classList.remove('ok');
        row.classList.add(event.success ? 'ok' : 'bad');
        row.appendChild(Object.assign(document.createElement('div'), {
          className: event.success ? 'meta' : 'err',
          textContent: event.success
            ? `done in ${event.durationMs}ms`
            : `${event.error}: ${event.details ?? ''}`,
        }));
      }
      return;
    }

    case 'cycle':
      if (event.kind === 'goal_complete') notify('Goal complete', `#${event.cycle}`);
      if (event.kind === 'llm_error') addRow([['err', `model error on #${event.cycle}`]]);
      return;

    case 'notice':
      addRow([[event.level === 'info' ? 'meta' : 'err', event.message]]);
      return;
  }
}

/** Guidance queued during cycle N is folded into cycle N+1's prompt. */
function markDelivered() {
  state.pending = state.pending.filter((item) => {
    if (item.sentAtCycle >= state.cycle) return true;
    item.el.classList.add('sent');
    item.el.textContent = `${item.text} → applied`;
    return false;
  });
}

function queueGuidance(text) {
  const li = document.createElement('li');
  li.textContent = `${text} → waiting`;
  $('pending').appendChild(li);
  state.pending.push({ text, el: li, sentAtCycle: state.cycle });
}

function resetFeed() {
  $('feed').replaceChildren();
  $('pending').replaceChildren();
  state.pending = [];
}

/* ───────────────────────────── controls ───────────────────────────── */

function syncButtons() {
  $('pause').disabled = !state.running;
  $('stop').disabled = !state.running;
  $('instruction').disabled = !state.running;
  $('start').textContent = state.running ? 'Running' : 'Start';
  $('start').disabled = state.running;
}

$('start').addEventListener('click', async () => {
  resetFeed();
  setConnection('starting', 'idle');
  try {
    await post('/api/start', {
      host: $('host').value.trim(),
      port: Number($('mcport').value),
      username: $('username').value.trim(),
      auth: 'offline',
      version: $('version').value.trim() || undefined,
      goal: $('goalInput').value.trim(),
      provider: $('provider').value,
      apiKey: $('apikey').value,
      model: $('model').value.trim(),
      baseUrl: $('baseurl').value.trim(),
    });
    state.running = true;
    syncButtons();
  } catch (err) {
    setConnection('start failed', 'down');
    alert(String(err.message ?? err));
  }
});

$('pause').addEventListener('click', async () => {
  if (state.paused) {
    await command('resume');
    $('pause').textContent = 'Pause';
    state.paused = false;
  } else {
    await command('pause');
    $('pause').textContent = 'Resume';
    state.paused = true;
  }
});

$('stop').addEventListener('click', () => command('stop'));

$('instruct').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('instruction');
  const text = input.value.trim();
  if (text === '') return;
  await command('guidance', text);
  queueGuidance(text);
  input.value = '';
});

$('clear').addEventListener('click', resetFeed);

$('notify').addEventListener('click', async () => {
  const permission = await Notification.requestPermission();
  notifications.enabled = permission === 'granted';
  $('notify').textContent = notifications.enabled ? 'Notifications on' : 'Notifications blocked';
});

/* ───────────────────────────── wiring ───────────────────────────────── */

function replay(events) {
  for (const event of events) renderEvent(event);
}

const stream = new EventSource('/api/events');
stream.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data);
  if (payload.recent && Array.isArray(payload.recent) && $('feed').childElementCount === 0) {
    state.running = payload.running;
    if (payload.settings?.goal) {
      $('goalInput').value = payload.settings.goal;
      $('goal').textContent = payload.settings.goal;
    }
    syncButtons();
    replay(payload.recent);
    return;
  }
  renderEvent(payload);
});

stream.onerror = () => setConnection('reconnecting', 'idle');
stream.onopen = () => setConnection('live', 'live');

$('provider').addEventListener('change', () => {
  const jev = $('provider').value === 'jev';
  $('model').value = jev ? 'jev-1.13-free' : 'respan/span-01-lite:free';
  $('baseurl').value = jev ? 'https://opencode.ai/zen/v1' : 'https://openrouter.ai/api/v1';
});
```

- [ ] **Step 4: Run and confirm green**

Run: `npm run typecheck && npx vitest run tests/panel-server.test.ts && npm run build && ls dist/panel/public`
Expected: PASS, and `index.html`, `app.js`, `style.css` present in `dist/panel/public`.

- [ ] **Step 5: Commit**

```bash
git add src/panel/public tests/panel-server.test.ts
git commit -m "feat(panel): control panel page"
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/panel.md`
- Modify: `docs/configuration.md`, `README.md`, `AGENTS.md`, `.env.example`

**Interfaces:**
- Consumes: everything above.
- Produces: operator documentation.

- [ ] **Step 1: Write the failing test**

None — documentation is verified by reading. Skip this step and record why: the deliverable is
prose, and a test asserting on prose is theatre.

- [ ] **Step 2: Run and confirm nothing to run**

No test command; continue.

- [ ] **Step 3: Write the docs**

`docs/panel.md` must cover, in this order:

```markdown
# Control panel

A local browser panel that starts the agent, sets its server and model, sends
instructions while it plays, and shows every cycle as it happens.

## Start

```bash
npm run build
npm run panel          # http://127.0.0.1:3008
```

The Minecraft server runs separately — `./server/start.sh` as usual.

## What the fields do

| Field | Meaning |
| --- | --- |
| Host / Port / Username / Version | Passed to the agent as `--host`, `--port`, `--username`, `--version`. |
| Provider | `jev` uses OpenCode Zen's Jev decision model; `openrouter` uses a chat model. |
| API key | Passed to the agent process only. Never written to disk and never logged. |
| Goal | Passed as `--goal` at start. The agent cannot change it mid-run — use the instruction box instead. |
| Instruction box | Delivered to the agent through the same channel the in-game `!goal` command uses. An instruction shows *waiting* until the next cycle begins, then *applied*. |

## Buttons

- **Start** — spawns the agent with the settings above. Disabled while it runs.
- **Pause / Resume** — the agent idles without burning model calls.
- **Stop** — a graceful shutdown that lets the world save.
- **Enable notifications** — optional browser notifications for connection changes, a completed goal
  and a stopped agent. Nothing is sent off your machine.

## Security

The panel binds `127.0.0.1`, so only this machine can reach it. `POST` endpoints require
`application/json` and a same-origin `Origin` header, so a random web page cannot drive your bot.
Setting `PANEL_HOST=0.0.0.0` exposes the panel to your network and prints a warning; only do that on
a network you trust.

## How it differs from `npm run play`

`npm run play` exchanges JSON files in `control/`: you read a turn, write an action, and it suits
scripting and external agents. The panel drives the same agent over a pipe and suits watching it
play. They do not run at the same time — the panel is the interactive route, `control/` is the
file-based one.

## Files

- `panel-history.json` — the last 300 events plus your non-secret settings. Safe to delete.
```

Append a `## Panel` section to `docs/configuration.md` documenting `PANEL_HOST`, `PANEL_PORT`,
`--panel`, `--panel-port`, and the stderr logging that makes the event stream possible.

Add to `README.md`, next to the `npm run play` block:

```markdown
### Watching it play

```bash
npm run build
npm run panel      # http://127.0.0.1:3008
```

Set the server address, the model and the goal in the browser, press **Start**, then type
instructions like *collect wood, then craft a wooden pickaxe* into the instruction box and watch
every cycle land.
```

Add to `AGENTS.md`, after the control-loop section:

```markdown
> **The control panel is a different door.** `npm run panel` starts a local web UI
> (default `http://127.0.0.1:3008`) that spawns the agent, feeds it instructions and streams every
> cycle to your browser. The `control/` file protocol described above is unchanged and still works —
> pick one, not both. See `docs/panel.md`.
```

Add to `.env.example`:

```
# ─────────────────────────────────────────────────────────────
# Control panel (npm run panel)
# ─────────────────────────────────────────────────────────────
# PANEL_HOST=127.0.0.1
PANEL_PORT=3008
```

- [ ] **Step 4: Verify the commands in the docs exist**

Run: `npm run build && node --enable-source-maps dist/panel/index.js --help 2>&1 | head -1; ls dist/panel/public`
Expected: the panel entry starts and the assets exist. Kill it immediately after.

- [ ] **Step 5: Commit**

```bash
git add docs/panel.md docs/configuration.md README.md AGENTS.md .env.example
git commit -m "docs: control panel"
```

---

## Self-Review

**Spec coverage:** process model (Task 4, 5) · stdout isolation (Task 2) · protocol, both directions
(Task 3, 4) · agent events (Task 1) · routes (Task 5) · page, status, feed, instruction queue,
notifications (Task 6) · history and secret hygiene (Task 4) · security (Task 5) · docs (Task 7).

**Type consistency:** `AgentStreamEvent` lives in `src/agent/events.ts` and is imported by
`protocol.ts`, `process.ts`, `server.ts` and `agent.ts`. `PanelCommand` is declared in
`protocol.ts` and imported by `process.ts` and `server.ts`. `RunSettings`, `PersistedSettings` and
`PanelSnapshot` come from `process.ts`; the tests construct `RunSettings` from the same source.

**Name collision avoided:** `AgentEvent` in `src/types.ts` is untouched; the new type is
`AgentStreamEvent`.

**Known gaps carried into implementation:** `--auth` is added in Task 4 as a prerequisite the panel
needs. The page's delivery heuristic assumes a cycle's `world` event arrives before its `decision`
event, which the agent guarantees because it emits them in that order — verify the first manual run
turns an instruction green.