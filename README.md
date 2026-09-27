# Mindshaft

An LLM agent that plays Minecraft. Not a scripted bot: there is no hardcoded tech
tree and no "wood, then stone, then iron" ladder in the code. The agent observes
the world, turns it into compact JSON, asks a model for **one** action, validates
and executes it through Mineflayer, observes the result, and repeats.

An AI agent or a person can also drive it directly, with no model involved.

```text
Minecraft server
       │  (mineflayer)
       ▼
┌──────────────────────┐
│    World Observer    │  player · blocks · entities · inventory · time · threats
└──────────┬───────────┘
           ▼
  compact JSON state  ────►  model, or you  ────►  structured tool call
           ▲                                               │
           │                                               ▼
┌──────────┴───────────┐                       ┌───────────────────────┐
│   Memory + Goals     │ ◄──── structured ─────│    Tool Registry      │
│  actions · events    │       result          │  schema validation    │
│  facts · locations   │                       │  timeouts · limits    │
└──────────────────────┘                       └───────────┬───────────┘
                                                           ▼
                                                     Mineflayer
```

Alongside that loop a **reactive safety layer** runs on the physics tick without
consulting the model: it eats when starving, halts near lava, surfaces when
drowning, flees when nearly dead, and builds the bot out of a pit. A model thinks
on a multi-second cycle, which is far too slow to survive a creeper at point-blank
range.

## Requirements

Node.js **20.11+** (22 LTS recommended) and npm 10+. `server/setup.sh` fetches a
vanilla Minecraft 1.21.8 server and its own Java 21 runtime, so no system Java or
Minecraft install is needed. Any Java Edition server from 1.8.8 to 1.21.x works
too — point the agent at it with `--host` and `--port`.

## Quick start

```bash
npm install && npm run build
```

Set up and start the bundled server (the first command downloads the server jar
and a Java 21 runtime, and asks you to accept Mojang's EULA):

```bash
./server/setup.sh && ./server/start.sh
```

Then pick who plays.

**You or another AI agent** — no API key needed:

```bash
npm run play
```

This creates a `control/` folder: read `turn.json`, write `action.json`, repeat.
See **[AGENTS.md](AGENTS.md)**.

**A model** — put an [OpenRouter](https://openrouter.ai/keys) key in `.env` first:

```bash
cp .env.example .env
```

```bash
npm run start -- --goal "Find iron and craft an iron pickaxe"
```

Join `localhost` from a 1.21.8 Minecraft client to watch it play. There is also a
browser view (`--viewer`, `http://localhost:3007`), but it needs the native
`canvas` module — see [docs/troubleshooting.md](docs/troubleshooting.md).

Stop with **Ctrl+C**: it finishes the current action, disconnects cleanly, and
prints a run summary.

## Example goals

The agent derives its own plan. For "an iron pickaxe" it has to work out that it
needs wood, planks, a crafting table, a wooden pickaxe, stone, a stone pickaxe,
iron ore, a furnace and smelting — and re-plan whenever a step fails. None of
that sequence appears anywhere in the codebase.

```bash
npm run start -- --goal "Survive and obtain iron"
```

```bash
npm run start -- --goal "Gather 20 wood and build a small shelter"
```

```bash
npm run start -- --goal "Explore the world and map what you find"
```

Goals naming a concrete item are **verified**: a claim of completion is rejected
if the item is not actually in the inventory. Open-ended goals ("explore",
"survive") never auto-complete.

## Documentation

| Document | Contents |
| -------- | -------- |
| **[AGENTS.md](AGENTS.md)** | **How an AI agent plays the game.** The turn loop, the rules, the pitfalls. |
| [docs/configuration.md](docs/configuration.md) | Every environment variable and CLI flag. |
| [docs/tools.md](docs/tools.md) | The 17 tools, their arguments, and every error code. |
| [docs/architecture.md](docs/architecture.md) | Module layout, perception and compression, memory, logging, model compatibility. |
| [docs/in-game-commands.md](docs/in-game-commands.md) | Retasking the agent from Minecraft chat, and watching it. |
| [docs/testing.md](docs/testing.md) | Running the suite, and what has been verified live. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common failures and what they mean. |
| [docs/security.md](docs/security.md) | The trust boundary, and why model output cannot escape it. |
| [server/README.md](server/README.md) | The bundled server: console, `/give`, opping a username. |

## Development

```bash
npm test
```

```bash
npm run typecheck
```

474 tests, none of which need a Minecraft server or an API key.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Mojang Studios or Microsoft.
