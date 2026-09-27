# AGENTS.md — you are playing Minecraft

If you are an AI agent with file access and this repository in front of you, this
file is everything you need. You will control a real Minecraft character on a
real server, one action at a time.

You do **not** need an API key, a model, or network access. You are the model.

---

## Start

Two terminals. First the server — the setup step is a one-off that downloads the
server jar and a Java 21 runtime:

```bash
./server/setup.sh && ./server/start.sh
```

If it exits with `session.lock: already locked`, an older server is still holding
the world — stop it first (`ps -eo pid,args | grep server.jar`). Stop the server
later with `echo "stop" > server/console.in`, not by killing it, so the world is
saved.

Wait for `Done (…)!`, then the agent:

```bash
npm run build && npm run play
```

`npm run play` connects the bot and creates a `control/` directory. To pick your
own name and goal:

```bash
npm run play -- --username Claude --goal "Survive the first night"
```

A username may only contain letters, digits and underscores, up to 16
characters — Minecraft rejects spaces, so `Claude_Opus_5`, not `Claude Opus 5`.

Add `--viewer` and a human can watch you at `http://localhost:3007`.

---

## The loop

You repeat three steps for as long as you want to play.

| Step | File | Direction |
| ---- | ---- | --------- |
| 1. Read the situation | `control/turn.json` | agent → you |
| 2. Decide | `control/action.json` | you → agent |
| 3. Read what happened | `control/last-result.json` | agent → you |

Then `turn.json` reappears with a higher `turn` number and you go again.

`control/briefing.md` is generated at startup and lists every tool with its exact
arguments and bounds. Read it once before your first move.

### Step 1 — read the turn

```bash
cat control/turn.json
```

`situation` is the interesting field. It contains your goal, the compact world
state, your recent actions and their failures, and anything you asked to
remember.

### Step 2 — write one action

Either write the file directly:

```json
{
  "reason": "there is an oak tree 3 blocks north-east and I need wood",
  "tool": "mine",
  "arguments": { "block": "oak_log", "count": 3 },
  "turn": 7
}
```

Or use the CLI, which stamps the turn number for you:

```bash
npm run act -- mine block=oak_log count=3 --reason "need wood"
```

```bash
npm run act -- move_to x=126 y=64 z=-30
```

```bash
npm run act -- --show      # print the current turn instead of acting
```

Optional fields: `remember` (a fact carried into later turns) and
`goal_complete` (only when genuinely finished — it is checked against your
inventory and rejected if you are lying).

### Step 3 — read the result

```bash
cat control/last-result.json
```

On failure you get a machine-readable `error` and a `details` string written for
you to act on. Read it. It says precisely what went wrong.

---

## Rules that will actually bite you

**One tool per turn.** Not a plan, not a list. The single next action.

**Wait for the turn number to change** before writing your next action. If you
write `action.json` while the bot is still executing the previous one, it can be
overwritten. Including `"turn": N` makes the agent discard a mis-timed action
instead of applying it to a world that has moved on — `npm run act` does this
automatically.

**Axes:** `-Z` is north, `+X` is east, `+Y` is up. Every nearby block and entity
also carries `distance`, a compass `direction`, and a `relative` offset. Use
those; they are easier to reason about than absolute coordinates.

**`nearbyBlocks` is aggregated.** One entry per block type, with a `count` and the
`nearest` instance. `"count": 40` for stone means stone is all around you, not
that there are exactly 40 blocks.

**Digging straight down strands you.** If `turn.json` contains a `STUCK` field you
are walled in on all four sides and cannot walk or jump out. Use `pillar_up`
before anything else.

**Reach is about 4.5 blocks.** The tools walk you to a target automatically, but
a block sealed behind other blocks is not reachable — mine your way in.

**Placing a block** needs an empty destination *and* a solid neighbour to attach
to. Mid-air placement fails.

**Crafting** may need a crafting table nearby. Place one from your inventory
first. Smelting needs a furnace and fuel. Both report exactly what is missing.

**Climbing a tree can suffocate you.** Leaves are solid blocks. If you mine
upward into a canopy your head ends up inside a leaf block, which costs health
and air, and the safety layer will interrupt whatever you were doing to tell you.
When a turn says *your head is inside spruce_leaves*, mine that block or step out
before continuing. Mining a trunk from the ground avoids this entirely.

**Night is dangerous.** Hostile mobs spawn in the dark. A shelter, a light source
and a weapon all help. A bed lets you skip the night entirely — but you can only
sleep at night or during a thunderstorm, and not with a hostile mob nearby.

**Do not repeat a failing call.** After 5 consecutive failures the run stops. The
turn will warn you when you have tried the same thing three times.

---

## What you cannot do

The agent is a hard boundary, not a suggestion:

- You can only name one of the registered tools. There is no way to run code,
  read files, or reach a shell through an action.
- Every argument is validated against a schema before it reaches Minecraft.
  Out-of-range coordinates, unknown item names and bad types are rejected with an
  explanation, not attempted.
- A single `move_to` is capped at 64 blocks. Longer journeys need several hops.
- Every action is cancelled after at most 30 seconds.
- You cannot attack players. Bedrock, portals and command blocks cannot be
  broken.

## What happens without you

A **reactive safety layer** runs on the physics tick and does not consult you. It
eats when you are starving, halts movement near lava, swims up when drowning,
flees when you are nearly dead, and builds you out of a pit if you sit in one too
long. It may cancel your action — a result of `ABORTED` means it intervened.
Re-read the turn rather than blindly retrying.

This is why a turn can take a few seconds even when you answer instantly.

---

## A reasonable first session

Nothing here is enforced — it is just what tends to work.

1. `observe` and read what is around you.
2. `mine` 4–6 logs from the nearest tree.
3. `craft` planks, then a crafting table, then sticks.
4. `place_block` the crafting table, then `craft` a wooden pickaxe.
5. `mine` stone, `craft` a stone pickaxe and a stone sword.
6. Before dusk (`environment.timeOfDay`), dig or wall a small shelter, or make a
   bed from 3 planks and 3 wool and sleep through the night. Wool comes from
   sheep — shears or a sword both work.
7. Then go looking for iron.

Check `environment.timeOfDay`, `isDay`, `lightLevel` and your `health`/`food`
every turn — the day/night cycle is visible to you and it is the single most
important thing to plan around. `dusk` means you have roughly a minute of real
time before hostile mobs start spawning.

---

## Playing with a model instead

If you would rather a language model played, set `OPENROUTER_API_KEY` in `.env`
and run `npm run start -- --goal "..."`. The control directory is not used.
Everything else — the validation, the limits, the safety layer — is identical.
See [docs/configuration.md](docs/configuration.md).
