import { createBot, type Bot, type BotOptions } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import type { MinecraftConfig } from '../config/config.js';
import { tagged, type Logger } from '../utils/logger.js';

export class BotConnectionError extends Error {
  public override readonly name = 'BotConnectionError';
}

export type SessionEndReason = 'kicked' | 'end' | 'error' | 'quit';

export interface SessionEnd {
  reason: SessionEndReason;
  details: string;
}

/**
 * Owns the Mineflayer bot lifecycle: creation, plugin loading, waiting for the
 * first spawn, and a single well-defined "session is over" signal that the
 * action loop can await.
 */
export class BotSession {
  private readonly log: Logger;
  private readonly cfg: MinecraftConfig;
  private botInstance: Bot | null = null;
  private ended: SessionEnd | null = null;
  private endWaiters: Array<(end: SessionEnd) => void> = [];

  public constructor(cfg: MinecraftConfig, logger?: Logger) {
    this.cfg = cfg;
    this.log = tagged('BOT', logger);
  }

  /** The live bot. Throws before `connect()` resolves. */
  public get bot(): Bot {
    if (!this.botInstance) {
      throw new BotConnectionError('Bot is not connected yet — call connect() first.');
    }
    return this.botInstance;
  }

  public get isConnected(): boolean {
    return this.botInstance !== null && this.ended === null;
  }

  public get endState(): SessionEnd | null {
    return this.ended;
  }

  /**
   * Creates the bot and resolves once it has spawned and its chunks are loaded.
   * Rejects on kick/error before the first spawn, and on `timeoutMs`.
   */
  public async connect(timeoutMs = 60_000): Promise<Bot> {
    const options: BotOptions = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      auth: this.cfg.auth,
      // Mineflayer would otherwise dump raw errors straight to stderr; every
      // error reaches our own handlers, which log them through pino instead.
      hideErrors: true,
      // Keep chunk traffic modest: the observer only looks a few blocks out.
      viewDistance: 'short',
      checkTimeoutInterval: 60_000,
    };
    if (this.cfg.version) options.version = this.cfg.version;
    if (this.cfg.auth === 'microsoft' && this.cfg.password) options.password = this.cfg.password;

    const bot = createBot(options);
    this.botInstance = bot;
    bot.loadPlugin(pathfinder);

    this.wireLifecycle(bot);

    await this.awaitSpawn(bot, timeoutMs);

    // Chunks around the spawn point must exist before the observer can see
    // anything; without this the first observation is an empty world.
    await bot.waitForChunksToLoad();

    // A vanilla server often sends a placeholder position with the first spawn
    // packet and only then teleports the player to the real spawn point. Acting
    // on the placeholder wastes the first decision on a world that is nowhere
    // near the bot, so wait for the position to settle.
    await this.awaitStablePosition(bot);

    this.log.info(
      {
        username: bot.username,
        version: bot.version,
        gamemode: bot.game?.gameMode,
        position: bot.entity?.position,
      },
      'spawned',
    );

    return bot;
  }

  /**
   * Waits until the bot's position stops changing, or `timeoutMs` elapses.
   *
   * Resolves as soon as the position has held still for `settleMs`, so a normal
   * connection costs only that much. A server-side teleport restarts the clock.
   */
  private async awaitStablePosition(bot: Bot, timeoutMs = 4_000, settleMs = 600): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = bot.entity?.position?.clone() ?? null;
    let stableSince = Date.now();
    let moved = false;

    const onForcedMove = (): void => {
      moved = true;
      stableSince = Date.now();
    };
    bot.on('forcedMove', onForcedMove);

    try {
      while (Date.now() < deadline) {
        await bot.waitForTicks(2);
        const current = bot.entity?.position;
        if (!current) continue;

        if (last === null || current.distanceTo(last) > 0.05) {
          last = current.clone();
          stableSince = Date.now();
          continue;
        }
        if (Date.now() - stableSince >= settleMs) break;
      }
    } finally {
      bot.removeListener('forcedMove', onForcedMove);
    }

    if (moved) {
      this.log.debug(
        { position: bot.entity?.position },
        'server relocated the bot after spawn; using the settled position',
      );
    }
  }

  private awaitSpawn(bot: Bot, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new BotConnectionError(
            `Timed out after ${timeoutMs}ms waiting to spawn at ${this.cfg.host}:${this.cfg.port}. ` +
              'Is the server running and reachable?',
          ),
        );
      }, timeoutMs);

      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new BotConnectionError(`Connection failed: ${err.message}`));
      };
      const onKicked = (reason: string): void => {
        cleanup();
        reject(new BotConnectionError(`Kicked before spawn: ${reason}`));
      };
      const onEnd = (reason: string): void => {
        cleanup();
        reject(new BotConnectionError(`Connection closed before spawn: ${reason}`));
      };

      function cleanup(): void {
        clearTimeout(timer);
        bot.removeListener('spawn', onSpawn);
        bot.removeListener('error', onError);
        bot.removeListener('kicked', onKicked);
        bot.removeListener('end', onEnd);
      }

      bot.once('spawn', onSpawn);
      bot.once('error', onError);
      bot.once('kicked', onKicked);
      bot.once('end', onEnd);
    });
  }

  /** Registers the handlers that decide when the session is over. */
  private wireLifecycle(bot: Bot): void {
    bot.on('kicked', (reason, loggedIn) => {
      this.log.error({ loggedIn }, `kicked from server: ${stringifyReason(reason)}`);
      this.finish({ reason: 'kicked', details: stringifyReason(reason) });
    });

    bot.on('end', (reason) => {
      this.log.warn(`connection ended: ${reason}`);
      this.finish({ reason: 'end', details: reason });
    });

    bot.on('error', (err) => {
      // Mineflayer surfaces recoverable protocol noise here too; log and let
      // 'end' decide whether the session is actually finished.
      this.log.error({ err: { message: err.message, name: err.name } }, 'bot error');
      if (isFatalBotError(err)) {
        this.finish({ reason: 'error', details: err.message });
      }
    });
  }

  /** Resolves once the connection is gone, for whatever reason. */
  public waitForEnd(): Promise<SessionEnd> {
    if (this.ended) return Promise.resolve(this.ended);
    return new Promise((resolve) => {
      this.endWaiters.push(resolve);
    });
  }

  private finish(end: SessionEnd): void {
    if (this.ended) return;
    this.ended = end;
    const waiters = this.endWaiters;
    this.endWaiters = [];
    for (const waiter of waiters) waiter(end);
  }

  /** Cleanly disconnects. Safe to call more than once. */
  public quit(reason = 'shutting down'): void {
    const bot = this.botInstance;
    if (!bot) return;
    this.finish({ reason: 'quit', details: reason });
    try {
      bot.quit(reason);
    } catch (err) {
      this.log.debug({ err }, 'error while quitting (ignored)');
    }
  }
}

function stringifyReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/** Distinguishes connection-fatal errors from transient protocol warnings. */
function isFatalBotError(err: Error): boolean {
  const message = err.message.toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('socket closed') ||
    message.includes('etimedout')
  );
}
