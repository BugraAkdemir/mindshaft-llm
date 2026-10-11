import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// `quiet` keeps dotenv's banner out of CLI and test output.
loadDotenv({ quiet: true });

/* ─────────────────────────── Schema definition ────────────────────────── */

/** Accepts "1"/"true"/"yes"/"on" (case-insensitive) as true. */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

/** Parses an integer env var, falling back to `defaultValue` when unset/blank. */
const intIn = (min: number, max: number, defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : Number(value)))
    .pipe(z.number().int().min(min).max(max));

const floatIn = (min: number, max: number, defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : Number(value)))
    .pipe(z.number().min(min).max(max));

const nonEmpty = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : value.trim()));

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

export const LlmModeSchema = z.enum(['auto', 'tools', 'json']);
export type LlmMode = z.infer<typeof LlmModeSchema>;

const RawEnvSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: nonEmpty('respan/span-01-lite:free'),
  OPENROUTER_BASE_URL: nonEmpty('https://openrouter.ai/api/v1'),
  OPENROUTER_SITE_URL: optionalString,
  OPENROUTER_APP_NAME: nonEmpty('mindshaft-llm'),

  LLM_MODE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'auto' : v.trim().toLowerCase()))
    .pipe(LlmModeSchema),
  LLM_PROVIDER: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'openrouter' : v.trim().toLowerCase()))
    .pipe(z.enum(['openrouter', 'jev'])),
  LLM_TEMPERATURE: floatIn(0, 2, 0.3),
  LLM_MAX_TOKENS: intIn(128, 32_768, 1024),
  LLM_REQUEST_TIMEOUT_MS: intIn(1_000, 300_000, 45_000),
  LLM_MAX_RETRIES: intIn(0, 5, 2),

  // OpenCode Zen — Jev, a "System One" model. It answers typed questions at
  // /systemone rather than generating text, so it needs its own settings.
  JEV_API_KEY: optionalString,
  JEV_MODEL: nonEmpty('jev-1.13-free'),
  JEV_BASE_URL: nonEmpty('https://opencode.ai/zen/v1'),
  JEV_REQUEST_TIMEOUT_MS: intIn(1_000, 300_000, 30_000),
  JEV_MAX_RETRIES: intIn(0, 5, 2),
  JEV_CONFIDENCE_THRESHOLD: floatIn(0, 1, 0.25),

  MC_HOST: nonEmpty('localhost'),
  MC_PORT: intIn(1, 65_535, 25_565),
  MC_USERNAME: nonEmpty('AI_Agent'),
  MC_AUTH: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'offline' : v.trim().toLowerCase()))
    .pipe(z.enum(['offline', 'microsoft'])),
  MC_PASSWORD: optionalString,
  MC_VERSION: optionalString,

  AGENT_GOAL: nonEmpty('Survive, gather resources, and explore the world.'),
  THINK_INTERVAL_MS: intIn(0, 120_000, 3_000),
  OBSERVATION_RADIUS: intIn(2, 64, 12),
  ENTITY_RADIUS: intIn(4, 128, 24),

  MAX_MOVE_DISTANCE: intIn(1, 256, 64),
  MAX_ACTION_TIMEOUT_MS: intIn(1_000, 120_000, 30_000),
  MAX_CONSECUTIVE_FAILURES: intIn(1, 50, 5),

  MEMORY_ACTION_HISTORY: intIn(1, 100, 12),
  MEMORY_EVENT_HISTORY: intIn(1, 100, 15),
  MEMORY_MAX_FACTS: intIn(1, 200, 25),

  REACTIVE_SAFETY: boolish(true),
  PANIC_HEALTH: intIn(1, 20, 6),
  CRITICAL_HEALTH: intIn(1, 20, 4),
  AUTO_EAT_FOOD_LEVEL: intIn(0, 20, 14),

  CONTROL_DIR: nonEmpty('control'),
  CONTROL_TIMEOUT_MS: intIn(5_000, 3_600_000, 600_000),
  CONTROL_POLL_MS: intIn(50, 5_000, 250),

  CHAT_COMMANDS: boolish(true),
  CHAT_COMMAND_USERS: nonEmpty(''),
  CHAT_COMMAND_PREFIX: nonEmpty('!'),

  VIEWER: boolish(false),
  VIEWER_PORT: intIn(1, 65_535, 3007),
  VIEWER_FIRST_PERSON: boolish(false),

  PANEL_HOST: nonEmpty('127.0.0.1'),
  PANEL_PORT: intIn(1, 65_535, 3008),

  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'info' : v.trim().toLowerCase()))
    .pipe(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])),
  LOG_PRETTY: boolish(true),
});

/* ──────────────────────────── Shaped config ───────────────────────────── */

export interface LlmConfig {
  apiKey: string;
  /** Which provider drives the agent. `jev` is a structured decision model. */
  provider: LlmProviderName;
  model: string;
  baseUrl: string;
  siteUrl: string | undefined;
  appName: string;
  mode: LlmMode;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

export type LlmProviderName = 'openrouter' | 'jev';

/** OpenCode Zen's Jev, reached at `{baseUrl}/systemone`. */
export interface JevConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Below this winning probability the decision is flagged but still acted on. */
  confidenceThreshold: number;
}

export interface MinecraftConfig {
  host: string;
  port: number;
  username: string;
  auth: 'offline' | 'microsoft';
  password: string | undefined;
  version: string | undefined;
}

export interface AgentConfig {
  goal: string;
  thinkIntervalMs: number;
  observationRadius: number;
  entityRadius: number;
  maxMoveDistance: number;
  maxActionTimeoutMs: number;
  maxConsecutiveFailures: number;
  memoryActionHistory: number;
  memoryEventHistory: number;
  memoryMaxFacts: number;
  reactiveSafety: boolean;
  panicHealth: number;
  criticalHealth: number;
  autoEatFoodLevel: number;
}

export interface ControlConfig {
  /** True when an external controller drives the agent instead of an LLM. */
  enabled: boolean;
  dir: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface ChatConfig {
  enabled: boolean;
  allowlist: string[];
  prefix: string;
}

export interface ViewerConfig {
  enabled: boolean;
  port: number;
  firstPerson: boolean;
}

/** The local web control panel. */
export interface PanelConfig {
  host: string;
  port: number;
}

export interface LogConfig {
  level: string;
  pretty: boolean;
  /** Records go to stderr, leaving stdout for the panel's event stream. */
  stderr: boolean;
}

export interface Config {
  llm: LlmConfig;
  jev: JevConfig;
  minecraft: MinecraftConfig;
  agent: AgentConfig;
  control: ControlConfig;
  chat: ChatConfig;
  viewer: ViewerConfig;
  panel: PanelConfig;
  log: LogConfig;
}

/** Values the CLI is allowed to override, after `--flag` parsing. */
export interface CliOverrides {
  goal?: string;
  model?: string;
  host?: string;
  port?: number;
  username?: string;
  debug?: boolean;
  auth?: 'offline' | 'microsoft';
  mode?: LlmMode;
  llmProvider?: LlmProviderName;
  version?: string;
  viewer?: boolean;
  viewerPort?: number;
  control?: boolean;
  controlDir?: string;
  /** Sends logs to stderr so stdout can carry the panel's event stream. */
  panel?: boolean;
  panelPort?: number;
}

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

/**
 * Builds the validated config from `env` plus CLI overrides.
 *
 * `requireApiKey` is false in tests and in `--help`, so that a missing key does
 * not stop the process before it has had a chance to print anything useful.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: CliOverrides = {},
  requireApiKey = true,
): Config {
  const parsed = RawEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;

  const apiKey = (e.OPENROUTER_API_KEY ?? '').trim();
  // Control mode is driven by an external controller writing files, so it makes
  // no API calls and needs no key.
  const needsApiKey = requireApiKey && overrides.control !== true;
  if (needsApiKey && apiKey === '') {
    throw new ConfigError(
      'OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key from ' +
        'https://openrouter.ai/keys\n' +
        'Or run without a model at all: npm run play  (you drive the bot yourself)',
    );
  }

  if (e.MC_AUTH === 'microsoft' && !e.MC_PASSWORD) {
    // Mineflayer supports device-code flow with no password, so this is a hint,
    // not an error — the user will be prompted in the terminal.
    // Intentionally no throw.
  }

  const criticalHealth = Math.min(e.CRITICAL_HEALTH, e.PANIC_HEALTH);

  return {
    llm: {
      apiKey,
      provider: overrides.llmProvider ?? e.LLM_PROVIDER,
      model: overrides.model ?? e.OPENROUTER_MODEL,
      baseUrl: e.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
      siteUrl: e.OPENROUTER_SITE_URL,
      appName: e.OPENROUTER_APP_NAME,
      mode: overrides.mode ?? e.LLM_MODE,
      temperature: e.LLM_TEMPERATURE,
      maxTokens: e.LLM_MAX_TOKENS,
      requestTimeoutMs: e.LLM_REQUEST_TIMEOUT_MS,
      maxRetries: e.LLM_MAX_RETRIES,
    },
    jev: {
      // One key file is enough: a blank JEV_API_KEY falls back to the
      // OpenRouter variable, so a Zen key can live in either place.
      apiKey: e.JEV_API_KEY ?? apiKey,
      model: e.JEV_MODEL,
      baseUrl: e.JEV_BASE_URL.replace(/\/+$/, ''),
      requestTimeoutMs: e.JEV_REQUEST_TIMEOUT_MS,
      maxRetries: e.JEV_MAX_RETRIES,
      confidenceThreshold: e.JEV_CONFIDENCE_THRESHOLD,
    },
    minecraft: {
      host: overrides.host ?? e.MC_HOST,
      port: overrides.port ?? e.MC_PORT,
      username: overrides.username ?? e.MC_USERNAME,
      auth: overrides.auth ?? e.MC_AUTH,
      password: e.MC_PASSWORD,
      version: overrides.version ?? e.MC_VERSION,
    },
    agent: {
      goal: overrides.goal ?? e.AGENT_GOAL,
      thinkIntervalMs: e.THINK_INTERVAL_MS,
      observationRadius: e.OBSERVATION_RADIUS,
      entityRadius: e.ENTITY_RADIUS,
      maxMoveDistance: e.MAX_MOVE_DISTANCE,
      maxActionTimeoutMs: e.MAX_ACTION_TIMEOUT_MS,
      maxConsecutiveFailures: e.MAX_CONSECUTIVE_FAILURES,
      memoryActionHistory: e.MEMORY_ACTION_HISTORY,
      memoryEventHistory: e.MEMORY_EVENT_HISTORY,
      memoryMaxFacts: e.MEMORY_MAX_FACTS,
      reactiveSafety: e.REACTIVE_SAFETY,
      panicHealth: e.PANIC_HEALTH,
      criticalHealth,
      autoEatFoodLevel: e.AUTO_EAT_FOOD_LEVEL,
    },
    control: {
      enabled: overrides.control ?? false,
      dir: overrides.controlDir ?? e.CONTROL_DIR,
      timeoutMs: e.CONTROL_TIMEOUT_MS,
      pollIntervalMs: e.CONTROL_POLL_MS,
    },
    chat: {
      enabled: e.CHAT_COMMANDS,
      allowlist: e.CHAT_COMMAND_USERS.split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
      prefix: e.CHAT_COMMAND_PREFIX,
    },
    viewer: {
      enabled: overrides.viewer ?? e.VIEWER,
      port: overrides.viewerPort ?? e.VIEWER_PORT,
      firstPerson: e.VIEWER_FIRST_PERSON,
    },
    panel: {
      host: e.PANEL_HOST,
      port: overrides.panelPort ?? e.PANEL_PORT,
    },
    log: {
      level: overrides.debug ? 'debug' : e.LOG_LEVEL,
      pretty: overrides.panel === true ? false : e.LOG_PRETTY,
      stderr: overrides.panel === true,
    },
  };
}

/* ─────────────────────────────── CLI parsing ──────────────────────────── */

export interface ParsedArgs {
  overrides: CliOverrides;
  help: boolean;
  errors: string[];
}

const FLAGS_WITH_VALUES = new Set([
  '--goal',
  '--model',
  '--host',
  '--port',
  '--username',
  '--auth',
  '--mode',
  '--llm-provider',
  '--version',
  '--viewer-port',
  '--panel-port',
  '--control-dir',
]);

/**
 * Minimal, dependency-free flag parser. Supports `--flag value` and
 * `--flag=value`; unknown flags are collected as errors rather than ignored, so
 * a typo cannot silently change the agent's behaviour.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const overrides: CliOverrides = {};
  const errors: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined) continue;

    if (raw === '--help' || raw === '-h') {
      help = true;
      continue;
    }
    if (raw === '--debug') {
      overrides.debug = true;
      continue;
    }
    if (raw === '--viewer') {
      overrides.viewer = true;
      continue;
    }
    if (raw === '--panel') {
      overrides.panel = true;
      continue;
    }
    if (raw === '--control' || raw === '--play') {
      overrides.control = true;
      continue;
    }
    if (!raw.startsWith('--')) {
      errors.push(`Unexpected positional argument: "${raw}"`);
      continue;
    }

    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    let value: string | undefined;

    if (eq !== -1) {
      value = raw.slice(eq + 1);
    } else if (FLAGS_WITH_VALUES.has(flag)) {
      value = argv[i + 1];
      i += 1;
    }

    if (!FLAGS_WITH_VALUES.has(flag)) {
      errors.push(`Unknown flag: "${flag}"`);
      continue;
    }
    if (value === undefined || value.startsWith('--')) {
      errors.push(`Flag "${flag}" requires a value.`);
      continue;
    }

    switch (flag) {
      case '--goal':
        overrides.goal = value;
        break;
      case '--model':
        overrides.model = value;
        break;
      case '--host':
        overrides.host = value;
        break;
      case '--username':
        overrides.username = value;
        break;
      case '--version':
        overrides.version = value;
        break;
      case '--port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          errors.push(`Invalid --port "${value}" (expected 1-65535).`);
        } else {
          overrides.port = port;
        }
        break;
      }
      case '--viewer-port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          errors.push(`Invalid --viewer-port "${value}" (expected 1-65535).`);
        } else {
          overrides.viewerPort = port;
          overrides.viewer = true;
        }
        break;
      }
      case '--panel-port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          errors.push(`Invalid --panel-port "${value}" (expected 1-65535).`);
        } else {
          overrides.panelPort = port;
          overrides.panel = true;
        }
        break;
      }
      case '--auth': {
        const auth = value.toLowerCase();
        if (auth === 'offline' || auth === 'microsoft') {
          overrides.auth = auth;
        } else {
          errors.push(`Invalid --auth "${value}" (expected offline | microsoft).`);
        }
        break;
      }
      case '--llm-provider': {
        const name = value.toLowerCase();
        if (name === 'openrouter' || name === 'jev') {
          overrides.llmProvider = name;
        } else {
          errors.push(`Invalid --llm-provider "${value}" (expected openrouter | jev).`);
        }
        break;
      }
      case '--control-dir':
        overrides.controlDir = value;
        overrides.control = true;
        break;
      case '--mode': {
        const mode = LlmModeSchema.safeParse(value.toLowerCase());
        if (!mode.success) {
          errors.push(`Invalid --mode "${value}" (expected auto | tools | json).`);
        } else {
          overrides.mode = mode.data;
        }
        break;
      }
      default:
        errors.push(`Unhandled flag: "${flag}"`);
    }
  }

  return { overrides, help, errors };
}

export const HELP_TEXT = `
Mindshaft — an LLM agent that plays Minecraft

Usage:
  npm run start -- [options]

Options:
  --goal <text>        Natural-language goal for the agent.
  --model <id>         OpenRouter model id (default: respan/span-01-lite:free).
  --host <host>        Minecraft server host.
  --port <port>        Minecraft server port.
  --username <name>    Bot username.
  --version <mc>       Force a Minecraft protocol version (default: auto-detect).
  --mode <auto|tools|json>
                       How to request actions from the model.
  --llm-provider <openrouter|jev>
                       Which provider drives the agent. "jev" uses OpenCode Zen's
                       Jev decision model, which answers typed questions instead
                       of generating text (default: openrouter).
  --auth <offline|microsoft>
                       Minecraft authentication mode.
  --control, --play    Let an external controller (you, or another AI agent)
                       play by exchanging JSON files in ./control. No API key.
  --control-dir <dir>  Directory for the control files (implies --control).
  --viewer             Open a live 3D view of the bot in your browser.
  --viewer-port <port> Port for the live view (default: 3007; implies --viewer).
  --panel             Send logs to stderr and the event stream to stdout, so the
                       web control panel can supervise this process.
  --panel-port <port> Port for the control panel (default: 3008; implies --panel).
  --debug              Verbose logging.
  -h, --help           Show this message.

Everything can also be set in .env — see .env.example.
`.trim();
