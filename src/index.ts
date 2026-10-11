#!/usr/bin/env node
import { ActionLoop, type LoopSummary } from './agent/action-loop.js';
import { Agent } from './agent/agent.js';
import {
  ConfigError,
  HELP_TEXT,
  loadConfig,
  parseArgs,
  type Config,
} from './config/config.js';
import { ExternalControlProvider } from './llm/external.js';
import { JevProvider } from './llm/jev.js';
import { OpenRouterProvider } from './llm/openrouter.js';
import type { LLMProvider } from './llm/provider.js';
import { startPanelBridge } from './panel/bridge.js';
import { resolve } from 'node:path';
import { createLogger, tagged, type Logger } from './utils/logger.js';

const DIVIDER = '────────────────────────────';

async function main(): Promise<number> {
  const { overrides, help, errors } = parseArgs(process.argv.slice(2));

  if (help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n\nRun with --help for usage.\n`);
    return 2;
  }

  let cfg: Config;
  try {
    cfg = loadConfig(process.env, overrides);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  printBanner(cfg);

  const logger = createLogger(cfg.log);

  // In control mode an external agent (or a person) supplies each decision by
  // writing a file, so no LLM and no API key are involved.
  const control = cfg.control.enabled
    ? new ExternalControlProvider(
        {
          dir: resolve(cfg.control.dir),
          timeoutMs: cfg.control.timeoutMs,
          pollIntervalMs: cfg.control.pollIntervalMs,
        },
        logger,
      )
    : null;

  const provider: LLMProvider =
    control ??
    (cfg.llm.provider === 'jev'
      ? new JevProvider(cfg.jev, logger)
      : new OpenRouterProvider(cfg.llm, logger));
  const agent = new Agent(cfg, provider, logger);
  const loop = new ActionLoop(agent, cfg, logger);

  if (control) {
    agent.setResultSink((result) => control.publishResult(result));
  }

  installShutdownHandlers(loop, agent, logger);

  // The panel owns this process, so stdout is reserved for its event stream.
  // `--panel` already routed the logs to stderr in `loadConfig`.
  if (cfg.log.stderr) startPanelBridge(agent, loop);

  try {
    const bot = await agent.start();

    if (control) {
      await control.prepare(agent.tools.specs(), agent.systemPromptText);
      printControlInstructions(control.directory);
    }
    printConnected(
      bot.username,
      bot.version,
      {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z,
        health: bot.health,
        food: bot.food,
      },
      agent.viewerUrl,
    );
  } catch (err) {
    process.stderr.write(`\nFailed to connect: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const summary = await loop.run();
  printSummary(summary);

  agent.stop(`agent finished: ${summary.reason}`);
  // Give the disconnect packet a moment to flush before the process exits.
  await new Promise((resolve) => setTimeout(resolve, 300));

  return summary.reason === 'goal_achieved' || summary.reason === 'manual_stop' ? 0 : 1;
}

/* ─────────────────────────────── first run ────────────────────────────── */

function printControlInstructions(directory: string): void {
  process.stdout.write(
    [
      '',
      'CONTROL MODE — you (or another AI agent) are playing.',
      DIVIDER,
      '',
      `Control folder: ${directory}`,
      '',
      '  1. Read  turn.json        the current situation',
      '  2. Write action.json      your decision, one JSON object',
      '  3. Read  last-result.json what happened',
      '',
      'Read README.md in that folder first — it explains everything,',
      'and briefing.md lists every available tool.',
      '',
      'Shortcut instead of writing JSON by hand:',
      '  npm run act -- mine block=oak_log count=3',
      '',
      DIVIDER,
      '',
    ].join('\n'),
  );
}

function printBanner(cfg: Config): void {
  process.stdout.write(
    [
      '',
      'Mindshaft',
      DIVIDER,
      '',
      cfg.control.enabled
        ? 'Driver: external control (no LLM)'
        : `Model: ${cfg.llm.provider === 'jev' ? cfg.jev.model : cfg.llm.model} via ${cfg.llm.provider}`,
      `Server: ${cfg.minecraft.host}:${cfg.minecraft.port}`,
      `Username: ${cfg.minecraft.username}`,
      ...(cfg.control.enabled ? [] : [`Mode: ${cfg.llm.mode}`]),
      '',
      'Goal:',
      cfg.agent.goal,
      '',
      'Waiting for Minecraft connection...',
      '',
    ].join('\n'),
  );
}

function printConnected(
  username: string,
  version: string,
  state: { x: number; y: number; z: number; health: number; food: number },
  viewerUrl: string | null,
): void {
  process.stdout.write(
    [
      '',
      'Connected to Minecraft.',
      '',
      `Username: ${username}`,
      `Version:  ${version}`,
      `Position: ${state.x.toFixed(1)}, ${state.y.toFixed(1)}, ${state.z.toFixed(1)}`,
      `Health:   ${state.health}/20`,
      `Food:     ${state.food}/20`,
      ...(viewerUrl ? ['', `Live view: ${viewerUrl}`] : []),
      '',
      'AI agent started. Press Ctrl+C to stop.',
      DIVIDER,
      '',
    ].join('\n'),
  );
}

function printSummary(summary: LoopSummary): void {
  process.stdout.write(
    [
      '',
      DIVIDER,
      'Run finished.',
      '',
      `Reason:   ${summary.reason}`,
      `Detail:   ${summary.detail}`,
      `Cycles:   ${summary.cycles}`,
      `Actions:  ${summary.successes} succeeded, ${summary.failures} failed`,
      `Elapsed:  ${(summary.elapsedMs / 1000).toFixed(1)}s`,
      '',
    ].join('\n'),
  );
}

/* ─────────────────────────── graceful shutdown ────────────────────────── */

function installShutdownHandlers(loop: ActionLoop, agent: Agent, logger: Logger): void {
  const log = tagged('BOT', logger);
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // A second Ctrl+C means "stop waiting and exit now".
      process.stderr.write('\nForced exit.\n');
      process.exit(130);
    }
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal} — finishing the current action and disconnecting...\n`);
    loop.requestStop('manual_stop', `received ${signal}`);

    // Safety net: if the current action will not yield, leave anyway.
    const forceTimer = setTimeout(() => {
      process.stderr.write('Shutdown timed out; exiting.\n');
      agent.stop('forced shutdown');
      process.exit(130);
    }, 20_000);
    forceTimer.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaught exception — shutting down');
    agent.stop('uncaught exception');
    process.exit(1);
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`\nFatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
