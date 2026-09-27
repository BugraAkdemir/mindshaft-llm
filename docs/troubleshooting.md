# Troubleshooting

**`OPENROUTER_API_KEY is not set`**
Only model-driven runs need a key. Copy `.env.example` to `.env` and add yours —
or play without one: `npm run play` (see [AGENTS.md](../AGENTS.md)).

**`Timed out waiting to spawn` / `ECONNREFUSED`**
The server is not running, or the host/port is wrong. Check with `--host` and `--port`, and
confirm the server is listening:

```bash
ss -ltnp | grep 25565
```

**`Kicked before spawn: ... not authenticated` or `Failed to verify username`**
The server has `online-mode=true` but `MC_AUTH=offline`. Either set `online-mode=false` in
`server.properties`, or set `MC_AUTH=microsoft` and use a real account.

**Every `mine` or `place_block` fails near spawn**
Set `spawn-protection=0` in `server.properties` and restart the server.

**`No endpoints found that support tool use`**
Harmless. The agent logs a warning, switches to strict JSON mode, and continues. Set
`LLM_MODE=json` to skip the first attempt entirely.

**The model keeps returning unparseable responses**
Small models sometimes wrap JSON in prose. The parser handles the common cases; if it still
struggles, lower `LLM_TEMPERATURE` or try a larger model with `--model`.

**`PATH_NOT_FOUND` over and over**
The target is genuinely unreachable — enclosed, across a gap, or too high. This is reported back
to the model, which should pick an intermediate waypoint. If it does not, the run stops after
`MAX_CONSECUTIVE_FAILURES`.

**The bot stops after a few cycles with `too_many_failures`**
By design: the agent gives up rather than burning tokens in a loop. The log shows which tool kept
failing and why. Raise `MAX_CONSECUTIVE_FAILURES` if the goal legitimately needs more retries.

**Crafting or smelting fails on a non-vanilla server**
Lightweight test servers (flying-squid, some proxies) do not implement crafting windows. Vanilla,
Paper and Spigot all work.

**`session.lock: already locked (possibly by other Minecraft instance?)`**
An earlier server process is still holding the world. Find and stop it, then
start again:

```bash
ps -eo pid,args | grep server.jar
```

Always stop the server with `echo "stop" > server/console.in` rather than killing
it, so the world is saved and the lock released.

**`live viewer unavailable (Cannot find module 'canvas')`**
`--viewer` needs the native `canvas` module, which `prismarine-viewer` does not
bundle. Either install it (it needs a C++ toolchain and cairo headers):

```bash
npm install canvas
```

…or skip the browser view and watch from inside the game — join `localhost` with
a 1.21.8 client. The agent logs the warning and keeps running either way.

**`Losing air … your head is inside <block>`**
Not a bug: the bot mined upward into a tree canopy and its head is inside a leaf
block, which vanilla treats as suffocation. The safety layer stops the current
action and names the block; mine it or move out. Prefer mining trunks from the
ground.

**Rate limited on the free tier**
Free OpenRouter models are heavily rate limited. Raise `THINK_INTERVAL_MS`, or use a paid model.
