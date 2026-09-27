import type { Bot } from 'mineflayer';
import { tagged, type Logger } from '../utils/logger.js';

export interface ViewerHandle {
  port: number;
  url: string;
  close: () => void;
}

/**
 * Optional live 3D view of what the bot sees, served over HTTP.
 *
 * `prismarine-viewer` is an optional dependency: it pulls in three.js and a
 * web server, which most runs do not need. It is imported dynamically so a
 * missing install degrades to a warning instead of breaking startup.
 */
export async function startViewer(
  bot: Bot,
  options: { port: number; firstPerson?: boolean; distance?: number },
  logger?: Logger,
): Promise<ViewerHandle | null> {
  const log = tagged('BOT', logger);

  let mineflayerViewer: (bot: Bot, options: Record<string, unknown>) => void;
  try {
    const viewerModule = (await import('prismarine-viewer')) as unknown as {
      default?: { mineflayer?: typeof mineflayerViewer };
      mineflayer?: typeof mineflayerViewer;
    };
    const resolved = viewerModule.mineflayer ?? viewerModule.default?.mineflayer;
    if (!resolved) throw new Error('prismarine-viewer did not export a mineflayer viewer');
    mineflayerViewer = resolved;
  } catch (err) {
    log.warn(
      `live viewer unavailable (${err instanceof Error ? err.message : String(err)}). ` +
        'Install it with: npm install prismarine-viewer',
    );
    return null;
  }

  try {
    mineflayerViewer(bot, {
      port: options.port,
      firstPerson: options.firstPerson ?? false,
      viewDistance: options.distance ?? 6,
    });
  } catch (err) {
    log.warn(`could not start the live viewer: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const url = `http://localhost:${options.port}`;
  log.info(`live viewer running at ${url}`);

  return {
    port: options.port,
    url,
    // The viewer attaches its own listeners to the bot; ending the bot tears
    // the whole thing down, so there is nothing to unwind here.
    close: () => undefined,
  };
}
