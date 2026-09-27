import pino from 'pino';

/** Log tags used throughout the agent so console output stays scannable. */
export type LogTag =
  | 'OBSERVE'
  | 'LLM'
  | 'TOOL'
  | 'RESULT'
  | 'EVENT'
  | 'ERROR'
  | 'GOAL'
  | 'SAFETY'
  | 'BOT'
  | 'MEMORY';

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

/**
 * Keys whose values must never reach the log stream. Pino's redact paths are
 * applied to nested objects too, so an accidental `{ config }` dump stays safe.
 */
const REDACT_PATHS = [
  'apiKey',
  'openrouterApiKey',
  'password',
  'token',
  'authorization',
  '*.apiKey',
  '*.openrouterApiKey',
  '*.password',
  '*.token',
  'llm.apiKey',
  'minecraft.password',
  'headers.Authorization',
  'headers.authorization',
];

export type Logger = pino.Logger;

let rootLogger: Logger | null = null;

export function createLogger(options: LoggerOptions): Logger {
  const base: pino.LoggerOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: undefined,
  };

  if (options.pretty) {
    rootLogger = pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{if tag}[{tag}] {end}{msg}',
        },
      },
    });
  } else {
    rootLogger = pino(base);
  }

  return rootLogger;
}

/** Returns the process-wide logger, creating a conservative default if needed. */
export function getLogger(): Logger {
  rootLogger ??= createLogger({ level: process.env['LOG_LEVEL'] ?? 'info', pretty: false });
  return rootLogger;
}

/**
 * Returns a child logger that stamps every record with `tag`, which the
 * pretty transport renders as a `[TAG]` prefix.
 */
export function tagged(tag: LogTag, logger: Logger = getLogger()): Logger {
  return logger.child({ tag });
}

/** Strips anything that looks like a bearer token out of free-form text. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, 'sk-or-v1-[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]');
}
