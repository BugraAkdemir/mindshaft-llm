# Giving orders from inside the game

A trusted player can retask the agent from Minecraft chat:

```text
!goal find iron and craft an iron pickaxe
!status
!pause
!resume
!stop
```

Set who is allowed in `.env` — this list is the entire security boundary:

```dotenv
CHAT_COMMAND_USERS=bugraa
```

Anyone not on that list is ignored silently. Chat from other players still
reaches the model, but only as an observation explicitly labelled untrusted, and
the system prompt tells the agent that a player asking for something is
information, not an instruction.

> **`/goal` cannot work, and that is a Minecraft limitation.** A vanilla server
> treats anything starting with `/` as a server command, answers "Unknown
> command" to the sender, and never relays it — so the bot cannot see it. Use the
> `!` prefix in public chat, or whisper the bot, where no prefix is needed:
>
> ```text
> /msg AI_Agent goal find iron
> ```

## Watching the bot

Two ways, and they work together:

**Join the server yourself.** Connect a 1.21.8 client to `localhost` and stand
next to it. This is the best way to see what it is actually doing.

**Open a browser view.** No Minecraft client needed:

```bash
npm run start -- --viewer --goal "Find iron"
```

The banner prints a `http://localhost:3007` link showing the world from the
bot's position. Change the port with `--viewer-port 4000`.

This depends on `prismarine-viewer`, which needs the native `canvas` module.
If it is missing the agent logs a warning and runs normally without the view —
install it with `npm install canvas` (a C++ toolchain and cairo headers are
required), or just watch from inside the game.
