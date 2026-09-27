# Bundled test server

A vanilla Minecraft **1.21.8** server, preconfigured for agent testing.

First run fetches the server jar and a Java 21 runtime (about 105 MB, neither is
in version control) and asks you to accept Mojang's EULA:

```bash
./server/setup.sh
```

After that, start it any time with:

```bash
./server/start.sh
```

Then, in another terminal, start the agent:

```bash
npm run start -- --goal "Find iron" --viewer
```

## What is preconfigured

| Setting              | Value | Why |
| -------------------- | ----- | --- |
| `online-mode`        | `false` | The bot connects without a Microsoft account. |
| `spawn-protection`   | `0`   | Without this the bot cannot break or place blocks near spawn. |
| `difficulty`         | `easy` | Hostile mobs still spawn, but hit less hard. |
| `enforce-secure-profile` | `false` | Required for offline-mode clients. |

To use `/gamemode`, `/tp`, `/give` or `/time set` while watching, op yourself
from the server console (see below).

## Joining to watch

In your Minecraft launcher, use a **1.21.8** profile, then
**Multiplayer → Direct Connection → `localhost`**.

To give yourself operator rights, write to the server console:

```bash
echo "op YOUR_NAME" > server/console.in
```

## Server console

`start.sh` creates `server/console.in`. Anything written there runs as a console
command:

```bash
echo "time set day" > server/console.in
```

```bash
echo "give bugraa diamond_pickaxe 1" > server/console.in
```

## Bundled Java

`server/jre21/` is an Eclipse Temurin Java 21 runtime, used so the server works
regardless of the system Java version. Override the memory limit with
`MC_MEMORY=4G ./server/start.sh`.

## Not in version control

`server.jar`, `jre21/`, `world/`, `libraries/`, `versions/`, `logs/` and the
player/op lists are gitignored — large binaries, generated state, or personal to
one machine. `./server/setup.sh` recreates the downloads; the world regenerates
on first start.

To start over with a brand-new world, stop the server and delete it:

```bash
echo "stop" > server/console.in && sleep 5 && rm -rf server/world
```
