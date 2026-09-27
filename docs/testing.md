# Testing

```bash
npm test
```

```bash
npm run test:coverage
```

```bash
npm run typecheck
```

**474 tests across 19 files**, none of which require a Minecraft server or an API key. They cover world-state compression, distance and compass-direction maths,
tool argument validation, malformed LLM responses, movement limits and failure mapping, stuck
detection, memory trimming, goal parsing and completion verification, event aggregation and
throttling, the reactive safety layer, pit detection and the pillar-up escape, the allowlist on
in-game commands, the file-based control protocol (including stale-turn rejection), the
OpenRouter wire format, every one of the 17 tools driven through the registry, and an end-to-end
integration suite that runs the full observe → decide → act → remember pipeline against a mocked
LLM and a fake Mineflayer bot.

The one module with low unit coverage is `minecraft/bot.ts` — the real socket lifecycle, which
cannot be meaningfully faked. It was verified by running the agent against a live server instead
(see below).

## Verified against a live vanilla server

Everything below was confirmed in-world on the bundled vanilla 1.21.8 server, driven through
control mode:

- **Pathfinding** — `move_to` walked 11.6 blocks in 2.35 s.
- **Mining** — 4 oak logs felled with automatic tool selection, drops collected and reported.
- **The full crafting chain** — 4 logs → 11 planks → crafting table → 4 sticks → table placed →
  **wooden pickaxe crafted at the table** (`usedCraftingTable: true`).
- **Pit escape** — dug three blocks straight down, the observation reported `STUCK`, and
  `pillar_up` placed three dirt blocks to climb from y=67 back to y=70.
- **In-game commands** — `!status`, `!goal`, a whispered `goal`, `!pause` and `!resume` all
  answered; an unknown command was refused and a non-allowlisted player was ignored silently.
- **Structured failures** — every error path reported an actionable code and detail.
- **Day/night awareness** — `timeOfDay`, `isDay` and `lightLevel` tracked correctly across a
  real dawn, so shelter decisions can be made from the observation alone.

A further session, played move by move by a coding agent on a freshly generated world, turned up
the suffocation case: mining upward into a spruce canopy put the bot's head inside a leaf block,
and the reactive layer was holding *jump* — the correct response to drowning, the wrong one for
being embedded in a solid block — which repeatedly aborted the dig. The two causes are now
distinguished, and a non-finite `oxygenLevel` (Mineflayer leaves it `undefined` until the server
first reports air supply, and `??` does not catch `NaN`) is treated as "full" rather than as an
emergency.

Four bugs surfaced only because of these live runs, and all four are fixed: reach was measured
from the feet rather than the eyes (so the bot refused to mine blocks below it); a multi-block
`mine` lost its partial results when the deadline fired; ambiguous recipes named an arbitrary wood
type; and the first observation used a placeholder spawn position before the server had finished
teleporting the bot to the real spawn.
