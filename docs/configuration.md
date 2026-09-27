# Configuration

Every setting has a working default. Copy the example file and edit what you need:

```bash
cp .env.example .env
```

CLI flags override `.env`.

## LLM

| Variable                 | Default                        | Meaning |
| ------------------------ | ------------------------------ | ------- |
| `OPENROUTER_API_KEY`     | *(required)*                   | Your OpenRouter key. Never commit it. |
| `OPENROUTER_MODEL`       | `respan/span-01-lite:free`     | Any OpenRouter model id. |
| `OPENROUTER_BASE_URL`    | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `OPENROUTER_SITE_URL`    | *(empty)*                      | Optional `HTTP-Referer` attribution header. |
| `OPENROUTER_APP_NAME`    | `mindshaft-llm`           | Optional `X-Title` attribution header. |
| `LLM_MODE`               | `auto`                         | `auto`, `tools`, or `json` — see [Model compatibility](architecture.md#model-compatibility). |
| `LLM_TEMPERATURE`        | `0.3`                          | Sampling temperature. |
| `LLM_MAX_TOKENS`         | `1024`                         | Max tokens per decision. |
| `LLM_REQUEST_TIMEOUT_MS` | `45000`                        | Per-request timeout. |
| `LLM_MAX_RETRIES`        | `2`                            | Retries on rate limits and 5xx. |

## Minecraft

| Variable       | Default     | Meaning |
| -------------- | ----------- | ------- |
| `MC_HOST`      | `localhost` | Server host. |
| `MC_PORT`      | `25565`     | Server port. |
| `MC_USERNAME`  | `AI_Agent`  | Bot username. |
| `MC_AUTH`      | `offline`   | `offline` or `microsoft`. |
| `MC_PASSWORD`  | *(empty)*   | Only for `microsoft` auth; omit to use the device-code flow. |
| `MC_VERSION`   | *(empty)*   | Force a protocol version. Empty means auto-detect. |

## Agent behaviour

| Variable                   | Default | Meaning |
| -------------------------- | ------- | ------- |
| `AGENT_GOAL`               | *(see `.env.example`)* | Default goal when `--goal` is omitted. |
| `THINK_INTERVAL_MS`        | `3000`  | Pause between cycles. Skipped automatically when in danger. |
| `OBSERVATION_RADIUS`       | `12`    | Block scan radius. |
| `ENTITY_RADIUS`            | `24`    | Entity scan radius. |
| `MAX_MOVE_DISTANCE`        | `64`    | Longest single `move_to`. |
| `MAX_ACTION_TIMEOUT_MS`    | `30000` | Hard ceiling on any one tool. |
| `MAX_CONSECUTIVE_FAILURES` | `5`     | Failures in a row before the run stops. |
| `MEMORY_ACTION_HISTORY`    | `12`    | Actions kept in the rolling context. |
| `MEMORY_EVENT_HISTORY`     | `15`    | Events kept in the rolling context. |
| `MEMORY_MAX_FACTS`         | `25`    | Durable facts kept. |
| `REACTIVE_SAFETY`          | `true`  | Enables the deterministic survival layer. |
| `PANIC_HEALTH`             | `6`     | Below this, threats interrupt long actions. |
| `CRITICAL_HEALTH`          | `4`     | Below this, the agent flees without asking the model. |
| `AUTO_EAT_FOOD_LEVEL`      | `14`    | Eats automatically at or below this hunger level. |
| `LOG_LEVEL`                | `info`  | `trace` … `error`. |
| `LOG_PRETTY`               | `true`  | Human-readable logs; set `false` for JSON lines. |

## Control mode, in-game commands and the live view

| Variable               | Default   | Meaning |
| ---------------------- | --------- | ------- |
| `CONTROL_DIR`          | `control` | Folder used to exchange turns with an external controller. |
| `CONTROL_TIMEOUT_MS`   | `600000`  | How long a turn waits for a decision. |
| `CONTROL_POLL_MS`      | `250`     | How often the agent looks for `action.json`. |
| `CHAT_COMMANDS`        | `true`    | Enables in-game commands. |
| `CHAT_COMMAND_USERS`   | *(empty)* | **The whole security boundary** — only these usernames are obeyed. Empty means nobody. |
| `CHAT_COMMAND_PREFIX`  | `!`       | Prefix for public-chat commands. |
| `VIEWER`               | `false`   | Start the browser 3D view. |
| `VIEWER_PORT`          | `3007`    | Port for the view. |
| `VIEWER_FIRST_PERSON`  | `false`   | First-person instead of over-the-shoulder. |

## CLI flags

Flags override `.env`. Both `--flag value` and `--flag=value` work.

| Flag                      | Effect |
| ------------------------- | ------ |
| `--goal <text>`           | Natural-language goal. |
| `--model <id>`            | OpenRouter model id. |
| `--host <host>`           | Server host. |
| `--port <port>`           | Server port. |
| `--username <name>`       | Bot username. |
| `--version <mc>`          | Force a Minecraft version. |
| `--mode <auto\|tools\|json>` | How actions are requested from the model. |
| `--control`, `--play`     | Let an external controller (you, or another AI agent) play. No API key. |
| `--control-dir <dir>`     | Where the control files live (implies `--control`). |
| `--viewer`                | Open a live 3D view in the browser. |
| `--viewer-port <port>`    | Port for the live view (implies `--viewer`). |
| `--debug`                 | Verbose logging. |
| `-h`, `--help`            | Usage. |

Unknown flags are rejected rather than ignored, so a typo cannot silently change behaviour.

Stop the agent with **Ctrl+C**. It finishes the current action, disconnects cleanly, and prints
a run summary. A second Ctrl+C exits immediately.
