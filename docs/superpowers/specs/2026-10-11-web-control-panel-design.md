# Web Control Panel — Design

**Date:** 2026-10-11
**Status:** Approved
**Scope:** A local browser panel that configures, starts, directs and observes a running
agent, replacing `.env` editing and the file-based control mode for interactive use.

## Problem

Operating the agent today means either editing `.env` and restarting, or hand-writing
`control/action.json` on every turn. Neither shows what the agent is doing while it runs.
Two related gaps: the server address is fixed at startup, and instructions cannot be
given once the agent is already playing — `AGENT_GOAL` is read once at boot, and
`Agent.queueGuidance()` exists but is reachable only from in-game chat commands.

## Process model

The panel owns the agent process rather than running inside it. A crash in either side
leaves the other alive, and the agent keeps the same lifecycle semantics it has today.

```
npm run panel
  └─ src/panel/server.ts            node:http on 127.0.0.1:3008
       └─ POST /api/start
            └─ spawn(node dist/index.js --panel <args>, stdio: [pipe, pipe, pipe])
                 stdout : JSON-lines event stream — nothing else
                 stderr : pino logs
                 stdin  : commands
```

The Minecraft server is unaffected and still runs separately via `server/start.sh`.

### stdout isolation

Pino writes to stdout by default (`src/utils/logger.ts:57`, `src/utils/logger.ts:70`),
which would corrupt the event stream. `LoggerOptions` gains `stderr: boolean`;
`--panel` sets `LOG_PRETTY=false` and routes to `pino.destination({ fd: 2 })`. Outside
panel mode nothing changes.

## Protocol

### Agent stdout → panel (one JSON object per line)

```jsonc
{"type":"lifecycle","status":"connecting"}      // connecting | connected | disconnected | stopped
{"type":"world","cycle":7,"health":20,"food":18,"pos":{...},"timeOfDay":"dusk","inventory":[...]}
{"type":"decision","cycle":7,"tool":"mine","arguments":{...},"reason":"...","latencyMs":812}
{"type":"result","cycle":7,"success":true,"data":{...},"durationMs":1400}
{"type":"cycle","cycle":7,"kind":"acted"}      // acted | llm_error | undecidable | goal_complete | disconnected
{"type":"notice","level":"warn","message":"safety layer acted automatically"}
```

### Panel stdin → agent

```jsonc
{"type":"guidance","text":"Collect wood, then craft wooden tools"}
{"type":"pause"}
{"type":"resume"}
{"type":"stop"}
```

`guidance` routes into the existing `Agent.queueGuidance()` (`src/agent/agent.ts:525`) —
the same channel the in-game `!goal` command uses. `pause` sets the existing `paused`
flag; `stop` calls `ActionLoop.requestStop`. No new agent behaviour is introduced, only
a new door into behaviour that already exists.

## Agent-side changes

- **`src/agent/events.ts`** — `AgentEvent` discriminated union plus a dependency-free
  emitter exposing `onEvent(cb): () => void`.
- **`Agent`** gains a `cycleCount` and four `emit()` calls in `runCycle()`
  (`src/agent/agent.ts:232`): observation, decision, result, cycle outcome. `ActionLoop`
  additionally emits `cycle` from its existing `switch` so kinds like `llm_error` and
  `goal_complete` are reported too. `setPaused(paused: boolean)` becomes public.
- **`src/panel/protocol.ts`** — agent side of the wire format. Takes injected
  `{ stdout, stdin }` rather than touching `process` directly, so it is testable.
- **`--panel`** is added to `parseArgs` following the existing `--viewer` pattern, and
  documented in `HELP_TEXT`.

## Panel side

| File | Responsibility |
| --- | --- |
| `src/panel/server.ts` | `node:http`; static files, four routes, no framework |
| `src/panel/process.ts` | Spawn, supervise, parse stdout, persist history |
| `src/panel/public/index.html` | Single page shell |
| `src/panel/public/app.js` | `fetch` + `EventSource`, no build step, no modules |
| `src/panel/public/style.css` | Layout and theme |

API routes: `GET /api/state` (snapshot for first paint), `GET /api/events` (SSE),
`POST /api/command`. Static assets are served from `GET /` with the usual path
resolution and a fixed directory root — no traversal above `public/`.

**Partial lines.** stdout arrives in arbitrary chunks, so `process.ts` buffers until a
`\n` before parsing. A split packet must never produce a malformed event or a lost line.

**Process supervision.** `exit` emits `{"type":"lifecycle","status":"stopped"}` carrying
the exit code, so the UI can distinguish a finished goal from a crash.

**History.** The last 300 cycles are written to `panel-history.json` and reloaded on page
refresh. Only non-secret run metadata is stored.

## Interface

Three regions:

| Left — settings | Right — live feed | Top — status bar |
| --- | --- | --- |
| Server: host, port, username, auth, version | One card per cycle: number, `tool(args)`, reason, ✓/✗, duration, error detail | connection · health · food · position · time of day · inventory · goal |
| Model: provider, key, model, base URL | Auto-scroll with a pause toggle | |
| Goal text | | |
| Start / Pause / Stop | | |
| Instruction box (Enter) | | |

**Instruction flow.** Text is POSTed, appears in a *pending* list, and leaves that list
when the agent starts a cycle that follows its delivery — turning green *applied*. The
operator therefore observes the instruction actually reaching the model instead of
assuming it did.

**Browser notifications.** Opt-in button requesting the Notification API. Fires only for
critical events: connection lost, connection restored, goal complete, repeated tool
failures, process exited. Never per cycle.

The 3D view is not embedded; `prismarine-viewer` keeps its own port and stays optional.

## Security

- The panel binds `127.0.0.1:3008` by default (`PANEL_HOST`, `PANEL_PORT`). Setting
  `PANEL_HOST=0.0.0.0` prints a prominent startup warning, mirroring the
  `CHAT_COMMAND_USERS` stance that untrusted input is a security decision, not a default.
- `POST /api/command` requires `Content-Type: application/json` and validates the `Origin`
  header, so a third-party page cannot drive the agent through the browser.
- **API keys are never written to disk.** They live in memory and are passed only to the
  spawned process as `OPENROUTER_API_KEY` / `JEV_API_KEY`. `panel-settings.json` holds
  only host, port, username, provider, model, base URL and goal. Panel log output runs
  through the existing `scrubSecrets`.

## Tests

`tests/panel.test.ts`, with a fake child process rather than a real spawn:

- a line split across two chunks is reassembled into one event
- commands are serialised correctly onto stdin
- process exit produces `stopped` with the exit code
- the four HTTP routes respond, against a temporary port
- history persists and reloads
- no API key appears in `panel-settings.json`, the history file or log output

`tests/events.test.ts` covers emit ordering and payload shape.

## Documentation

`docs/panel.md` (new), a `PANEL_*` section in `docs/configuration.md`, a quick-start line
in `README.md`, and a note in `AGENTS.md` recording how the panel differs from the
`control/` file protocol.

## Out of scope

Multi-user access, authentication, a mobile layout, the embedded 3D view, and any change
to the tool set or the decision logic itself.