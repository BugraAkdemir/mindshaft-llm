#!/usr/bin/env node
/**
 * Entry point for `npm run panel`.
 *
 * The panel is a supervisor, not a player: it spawns the agent as a child
 * process and talks to it over stdio. See `docs/panel.md`.
 */
import { resolve } from 'node:path';
import { AgentProcess } from './process.js';
import { createPanelServer } from './server.js';
import { createLogger } from '../utils/logger.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

async function main(): Promise<void> {
  const logger = createLogger({
    level: process.env['LOG_LEVEL'] ?? 'info',
    pretty: process.env['LOG_PRETTY'] !== 'false',
  });
  const cwd = resolve(process.argv[2] ?? '.');

  const agent = new AgentProcess({
    cwd,
    nodeBin: process.execPath,
    entry: resolve(cwd, 'dist/index.js'),
    historyPath: resolve(cwd, 'panel-history.json'),
    logger,
  });

  const server = createPanelServer({
    agent,
    publicDir: resolve(cwd, 'dist/panel/public'),
  });

  const host = process.env['PANEL_HOST'] ?? '127.0.0.1';
  const port = await server.listen(Number(process.env['PANEL_PORT'] ?? 3008), host);

  process.stdout.write(`Panel ready at http://${host}:${port}\n`);
  if (!LOOPBACK.has(host)) {
    process.stdout.write(
      `\nWARNING: the panel is bound to ${host}, so anyone who can reach this machine can\n` +
        `start and steer the bot. Only do this on a network you trust.\n\n`,
    );
  }

  const shutdown = (): void => {
    agent.stop();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});