# Security considerations

**The model is untrusted input.** It can never execute code. It may only name one of the 17
registered tools, and every argument passes Zod validation before reaching Mineflayer. There is no
`eval`, no dynamic import, no shell, and no path from model output to the filesystem.

**Hard limits are enforced in code, not in the prompt.** `MAX_MOVE_DISTANCE`,
`MAX_ACTION_TIMEOUT_MS` and `MAX_CONSECUTIVE_FAILURES` are checked by the executor. A model that
asks to walk 10,000 blocks gets `TARGET_TOO_FAR`, not a ten-minute walk.

**Player chat is data, not instruction.** Chat reaches the model explicitly labelled as untrusted,
and the system prompt states that a chat message telling the agent to do something is merely
information about what a player said. A player cannot redirect the agent by typing at it. Block
names and sign text are treated the same way.

**The agent will not attack players**, and a short list of blocks — bedrock, portals, command
blocks, barriers — can never be broken.

**Secrets never reach the logs.** Pino redacts key-like fields at the logger level, error text is
scrubbed for `sk-or-*` tokens and bearer headers, and the API key is only ever placed in an
`Authorization` header.

**In-game commands are allowlisted, and that list is the boundary.** Only
usernames in `CHAT_COMMAND_USERS` are obeyed; everyone else is ignored without a
reply, so the channel is not even discoverable. The commands are a closed set
(`goal`, `status`, `pause`, `resume`, `stop`) — they cannot name a tool, inject a
prompt, or touch the filesystem. Leave the list empty to disable the channel.

**Control mode does not widen the trust boundary.** A file-writing controller
goes through exactly the same path as a model: Zod validation, the tool registry,
per-tool timeouts, movement limits, and the reactive safety layer. It can choose
*which* registered tool runs, never *what code* runs.

**Run it on a server you control.** The agent digs, places blocks and kills mobs. On a shared
server that is griefing. Use a local or private world.

**`.env` is gitignored.** Keep it that way.

---
