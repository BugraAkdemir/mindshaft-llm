# Architecture

```text
src/
├── index.ts                  CLI, banner, graceful shutdown
├── types.ts                  shared state and result types
├── config/config.ts          env + CLI parsing, Zod-validated
├── act.ts                    CLI that writes a decision into control/
├── llm/
│   ├── provider.ts           LLMProvider interface (model-agnostic)
│   ├── openrouter.ts         OpenRouter client, retries, capability fallback
│   ├── external.ts           file-based control: you or an agent as the "model"
│   └── parser.ts             tolerant JSON extraction + decision validation
├── minecraft/
│   ├── bot.ts                Mineflayer lifecycle, spawn, disconnect
│   ├── registry.ts           minecraft-data wrapper: name resolution, classification
│   ├── observer.ts           world → compact JSON, with compression
│   ├── movement.ts           pathfinding, stuck detection, timeouts, cancellation
│   ├── blocks.ts             mining, placing, interacting, aiming
│   ├── inventory.ts          equip, eat, collect, tool selection
│   ├── combat.ts             melee, target resolution, fleeing
│   ├── crafting.ts           crafting and smelting
│   ├── events.ts             Mineflayer events → aggregated agent events
│   ├── chat-commands.ts      allowlisted in-game commands
│   ├── viewer.ts             optional browser 3D view
│   └── safety.ts             deterministic reactive survival layer
├── agent/
│   ├── agent.ts              the observe → decide → act cycle
│   ├── action-loop.ts        the outer loop and its stop conditions
│   ├── memory.ts             bounded short-term memory
│   ├── planner.ts            goal tracking and completion verification
│   └── prompts.ts            system and per-cycle prompt construction
├── tools/
│   ├── registry.ts           validation, timeouts, structured results
│   ├── schemas.ts            Zod schemas + JSON Schema emission
│   └── *-tools.ts            the 17 tool definitions
└── utils/
    ├── logger.ts             pino, with API-key redaction
    └── spatial.ts            distance, compass direction, relative offsets
```

Two notes on the layout: block actions live in `minecraft/blocks.ts` rather than being crammed
into `observer.ts`, and the reactive survival layer has its own `minecraft/safety.ts`. Both are
deliberate — they keep each module small and independently testable.

## Perception: why the state stays small

The model never sees screenshots and never sees the raw world. Three things keep an observation
to a few hundred tokens:

1. **Only classified blocks are scanned.** Ores, wood, hazards, workstations and a small sample of
   bulk terrain. Air and decoration are never reported.
2. **Identical blocks collapse into one entry** with a count and the nearest instance. A forest
   costs one line, not six hundred:

   ```json
   { "type": "oak_log", "count": 27, "nearest": { "x": 126, "y": 65, "z": -30 }, "distance": 2.4, "direction": "north-east" }
   ```

3. **Everything carries a relative description** — distance, compass direction, and a delta.
   A text-only model reasons far better about "9 blocks north-east" than about a pair of absolute
   coordinates.

Empty and default-valued fields are dropped before the state reaches the prompt.

## Memory

`MemoryManager` keeps bounded rolling buffers: recent actions with their results, aggregated
events, deduplicated durable facts, and known workstation locations. It also detects when the same
call has failed three times in a row and tells the model to stop trying it.

## Logging

Every line is tagged so a run is scannable:

```text
[OBSERVE] HP=20 Food=20 Pos=7,75,22 Blocks=2 Entities=0 Threats=0 Items=0
[LLM] Decision: move_to — walking toward the oak trees
[TOOL] move_to({"x":12,"y":75,"z":22})
[RESULT] success=true tool=move_to duration=2.35s {"travelled":11.6,"finalDistance":0.44}
[EVENT] Picked up 3x oak_log.
[SAFETY] Lava 1.8 blocks away — movement halted.
[GOAL] milestone: Have 12x oak_log.
```

API keys are redacted by pino at the logger level and scrubbed from error text, so they cannot
reach the log stream even if a provider echoes one back.

## Model compatibility

The LLM is reached through an `LLMProvider` interface (`src/llm/provider.ts`). `OpenRouterProvider`
is the only implementation, and nothing under `src/minecraft` or `src/tools` knows it exists —
swapping in another OpenAI-compatible endpoint, or a local model, means writing one new class.

`LLM_MODE` controls how actions are requested:

- **`auto`** (default) — try native tool calling; if the provider reports that the model has no
  tool-use endpoint, permanently fall back to strict JSON, rebuild the system prompt with the
  tool catalogue, and carry on. Nothing is lost.
- **`tools`** — native OpenAI-style tool calling only.
- **`json`** — strict JSON responses only. Widest compatibility.

Span-01 Lite is the default model but nothing is specialised for it. The JSON path is deliberately
forgiving: it recovers objects from code fences, from prose on either side, and from alias keys
(`name`/`args`/`parameters` instead of `tool`/`arguments`). Anything it cannot recover becomes a
structured correction message and the model gets up to two more attempts before the cycle is
abandoned.
