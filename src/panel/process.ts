import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrubSecrets, type Logger } from '../utils/logger.js';
import type { AgentStreamEvent } from '../agent/events.js';
import type { PanelCommand } from './protocol.js';

/** How many events are kept in memory for a page refresh. */
const HISTORY_LIMIT = 300;

export interface RunSettings {
  host: string;
  port: number;
  username: string;
  auth: 'offline' | 'microsoft';
  version?: string;
  goal: string;
  provider: 'openrouter' | 'jev';
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Exactly what the panel persists: `RunSettings` minus the secret. */
export type PersistedSettings = Omit<RunSettings, 'apiKey'>;

export interface PanelSnapshot {
  running: boolean;
  exitCode: number | null;
  lifecycle: string;
  lastWorld: Extract<AgentStreamEvent, { type: 'world' }> | null;
  recent: AgentStreamEvent[];
  settings: PersistedSettings | null;
}

/**
 * Turns an arbitrary byte stream into complete lines.
 *
 * `stdout` delivers whatever the kernel felt like — a JSON event can be split
 * across two chunks, and several events can arrive glued together. Parsing
 * each chunk as a whole line would both lose events and crash on the splits.
 */
export class LineSplitter {
  private buffer = '';

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== '') this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }
}

/**
 * Writes the settings the panel remembers between runs. The API key is
 * deliberately dropped here: it must never reach the disk.
 */
export function writePersistedSettings(path: string, settings: RunSettings): void {
  const { apiKey: _apiKey, ...safe } = settings;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
}

export function readPersistedSettings(path: string): PersistedSettings | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as PersistedSettings) : null;
  } catch {
    return null;
  }
}

/**
 * Owns the agent child process: spawns it, parses its event stream, forwards
 * commands and remembers the last run's settings.
 */
export class AgentProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private recent: AgentStreamEvent[] = [];
  private lastWorld: PanelSnapshot['lastWorld'] = null;
  private lifecycle = 'idle';
  private exitCode: number | null = null;
  private settings: PersistedSettings | null;

  public constructor(
    private readonly opts: {
      cwd: string;
      nodeBin: string;
      entry: string;
      historyPath: string;
      logger?: Logger;
    },
  ) {
    this.settings = readPersistedSettings(opts.historyPath);
    this.splitter = new LineSplitter((line) => this.consume(line));
  }

  private readonly splitter: LineSplitter;

  public on(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public get running(): boolean {
    return this.child !== null;
  }

  public snapshot(): PanelSnapshot {
    return {
      running: this.running,
      exitCode: this.exitCode,
      lifecycle: this.lifecycle,
      lastWorld: this.lastWorld,
      recent: [...this.recent],
      settings: this.settings,
    };
  }

  public start(settings: RunSettings): void {
    if (this.child) throw new Error('an agent is already running');

    const { apiKey, ...safe } = settings;
    this.settings = safe;
    this.exitCode = null;
    writePersistedSettings(this.opts.historyPath, settings);

    const args = [
      this.opts.entry,
      '--panel',
      '--host', settings.host,
      '--port', String(settings.port),
      '--username', settings.username,
      '--goal', settings.goal,
      '--llm-provider', settings.provider,
      '--auth', settings.auth,
      '--model', settings.model,
    ];
    if (settings.version) args.push('--version', settings.version);

    // The key reaches the child as an environment variable and nowhere else.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LOG_PRETTY: 'false',
      ...(settings.provider === 'jev'
        ? { JEV_API_KEY: apiKey, JEV_MODEL: settings.model, JEV_BASE_URL: settings.baseUrl }
        : {
            OPENROUTER_API_KEY: apiKey,
            OPENROUTER_MODEL: settings.model,
            OPENROUTER_BASE_URL: settings.baseUrl,
          }),
    };

    this.publish({ type: 'lifecycle', status: 'connecting' });

    const child = spawn(this.opts.nodeBin, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.splitter.push(chunk.toString('utf8')));
    // stderr is where the agent's logs go now that stdout is the event stream.
    child.stderr.on('data', (chunk: Buffer) => {
      this.opts.logger?.debug(
        { line: scrubSecrets(chunk.toString('utf8').slice(0, 300)) },
        'agent stderr',
      );
    });
    child.on('error', (err) => {
      this.publish({ type: 'lifecycle', status: 'stopped', detail: scrubSecrets(err.message) });
    });
    child.on('exit', (code) => {
      this.exitCode = code;
      this.child = null;
      this.publish({
        type: 'lifecycle',
        status: 'stopped',
        detail: code === 0 ? 'finished' : `exit code ${code}`,
      });
    });
  }

  public send(command: PanelCommand): void {
    const child = this.child;
    if (!child) throw new Error('no agent is running');
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  public stop(): void {
    this.child?.kill('SIGTERM');
  }

  private consume(line: string): void {
    let event: AgentStreamEvent;
    try {
      event = JSON.parse(line) as AgentStreamEvent;
    } catch {
      // A stray console.log from the agent. Ignore it rather than crash.
      return;
    }
    if (event.type === 'world') this.lastWorld = event;
    if (event.type === 'lifecycle') this.lifecycle = event.status;
    this.publish(event);
  }

  private publish(event: AgentStreamEvent): void {
    this.recent.push(event);
    if (this.recent.length > HISTORY_LIMIT) this.recent.shift();
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* one broken SSE client must not stop the run */
      }
    }
  }
}