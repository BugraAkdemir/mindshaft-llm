import type { Bot } from 'mineflayer';
import { tagged, type Logger } from '../utils/logger.js';

export interface ChatCommandConfig {
  enabled: boolean;
  /** Usernames permitted to issue commands. Empty means nobody. */
  allowlist: string[];
  /** Prefix for public-chat commands, e.g. `!`. */
  prefix: string;
}

export interface ChatCommandHandlers {
  setGoal: (goal: string) => void;
  status: () => string;
  stop: (reason: string) => void;
  pause: () => void;
  resume: () => void;
}

/**
 * Lets a trusted player steer the agent from inside the game.
 *
 * Two things make this safe to have at all:
 *
 * 1. **Only allowlisted usernames are obeyed.** Chat is attacker-controlled, so
 *    an open command channel would hand any player on the server the agent's
 *    goal. Everything from anyone else stays what it was before — inert data
 *    that merely gets reported to the model as an observation.
 * 2. **The commands are a closed set.** They set the goal or report status; they
 *    cannot name a tool, inject a prompt, or reach the filesystem.
 *
 * Note on the `/` prefix: a vanilla server swallows `/anything` as a command and
 * the bot never sees it, so public commands use a plain prefix (`!goal ...`).
 * Whispers (`/msg <bot> goal ...`) do reach the bot and are also accepted.
 */
export class ChatCommandListener {
  private readonly bot: Bot;
  private readonly cfg: ChatCommandConfig;
  private readonly handlers: ChatCommandHandlers;
  private readonly log: Logger;
  private readonly allowed: Set<string>;
  private attached = false;

  public constructor(bot: Bot, cfg: ChatCommandConfig, handlers: ChatCommandHandlers, logger?: Logger) {
    this.bot = bot;
    this.cfg = cfg;
    this.handlers = handlers;
    this.log = tagged('EVENT', logger);
    this.allowed = new Set(cfg.allowlist.map((name) => name.toLowerCase()));
  }

  public attach(): void {
    if (this.attached || !this.cfg.enabled) return;
    if (this.allowed.size === 0) {
      this.log.warn(
        'chat commands are enabled but CHAT_COMMAND_USERS is empty, so no one can issue them',
      );
      return;
    }
    this.attached = true;
    this.bot.on('chat', this.onChat);
    this.bot.on('whisper', this.onWhisper);
    this.log.info(
      `chat commands enabled for: ${[...this.allowed].join(', ')} (public prefix "${this.cfg.prefix}", or whisper the bot)`,
    );
  }

  public detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.bot.removeListener('chat', this.onChat);
    this.bot.removeListener('whisper', this.onWhisper);
  }

  private onChat = (username: string, message: string): void => {
    if (username === this.bot.username) return;
    if (!message.startsWith(this.cfg.prefix)) return;
    this.handle(username, message.slice(this.cfg.prefix.length), 'chat');
  };

  /** Whispers need no prefix — addressing the bot directly is intent enough. */
  private onWhisper = (username: string, message: string): void => {
    if (username === this.bot.username) return;
    const body = message.startsWith(this.cfg.prefix)
      ? message.slice(this.cfg.prefix.length)
      : message;
    this.handle(username, body, 'whisper');
  };

  private handle(username: string, body: string, via: 'chat' | 'whisper'): void {
    if (!this.allowed.has(username.toLowerCase())) {
      this.log.warn(`ignoring command from "${username}" — not in CHAT_COMMAND_USERS`);
      // Deliberately silent in-game: replying would confirm the channel exists.
      return;
    }

    const parsed = parseCommand(body);
    if (!parsed) return;

    this.log.info(`command from ${username} via ${via}: ${parsed.command}`);

    switch (parsed.command) {
      case 'goal': {
        if (parsed.argument === '') {
          this.reply(username, via, 'Usage: goal <what you want me to do>');
          return;
        }
        this.handlers.setGoal(parsed.argument);
        this.reply(username, via, `New goal: ${parsed.argument}`);
        return;
      }
      case 'status':
        this.reply(username, via, this.handlers.status());
        return;
      case 'stop':
        this.reply(username, via, 'Stopping.');
        this.handlers.stop(`stopped by ${username}`);
        return;
      case 'pause':
        this.handlers.pause();
        this.reply(username, via, 'Paused. Say "resume" to continue.');
        return;
      case 'resume':
        this.handlers.resume();
        this.reply(username, via, 'Resuming.');
        return;
      case 'help':
        this.reply(
          username,
          via,
          `Commands: ${this.cfg.prefix}goal <text>, ${this.cfg.prefix}status, ${this.cfg.prefix}pause, ${this.cfg.prefix}resume, ${this.cfg.prefix}stop`,
        );
        return;
      default:
        this.reply(username, via, `Unknown command "${parsed.command}". Try ${this.cfg.prefix}help`);
    }
  }

  private reply(username: string, via: 'chat' | 'whisper', text: string): void {
    // Minecraft drops overly long chat lines, so keep replies short.
    const safe = text.replace(/\n+/g, ' ').slice(0, 230);
    try {
      if (via === 'whisper') this.bot.whisper(username, safe);
      else this.bot.chat(safe);
    } catch (err) {
      this.log.debug({ err }, 'could not send chat reply');
    }
  }
}

export interface ParsedCommand {
  command: string;
  argument: string;
}

/** Splits `goal find some iron` into `{ command: 'goal', argument: 'find some iron' }`. */
export function parseCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;

  const space = trimmed.search(/\s/);
  if (space === -1) return { command: trimmed.toLowerCase(), argument: '' };

  return {
    command: trimmed.slice(0, space).toLowerCase(),
    // Goals are free text, so only the length is bounded.
    argument: trimmed.slice(space + 1).trim().slice(0, 300),
  };
}
