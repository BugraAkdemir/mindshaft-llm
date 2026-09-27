#!/usr/bin/env node
/**
 * Writes a decision into the control directory, so a controller can act without
 * hand-writing JSON:
 *
 *   npm run act -- mine block=oak_log count=3
 *   npm run act -- move_to x=126 y=64 z=-30 --reason "heading to the trees"
 *   npm run act -- observe
 *
 * Values are parsed as JSON when they look like JSON (numbers, booleans, objects
 * and arrays) and kept as strings otherwise, so `block=oak_log` and
 * `count=3` both do the sensible thing.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `
Usage:
  npm run act -- <tool> [key=value ...] [--reason "why"] [--remember "fact"]
                        [--goal-complete] [--dir control]

Examples:
  npm run act -- observe
  npm run act -- mine block=oak_log count=3
  npm run act -- move_to x=126 y=64 z=-30 --reason "walking to the forest"
  npm run act -- pillar_up height=3
  npm run act -- craft item=wooden_pickaxe

Run with --show to print the current turn instead of acting.
`.trim();

interface Parsed {
  tool: string | null;
  args: Record<string, unknown>;
  reason: string;
  remember: string | undefined;
  goalComplete: boolean;
  dir: string;
  show: boolean;
  help: boolean;
}

export function parseActArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    tool: null,
    args: {},
    reason: '',
    remember: undefined,
    goalComplete: false,
    dir: 'control',
    show: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === undefined) continue;

    if (raw === '--help' || raw === '-h') {
      parsed.help = true;
      continue;
    }
    if (raw === '--show') {
      parsed.show = true;
      continue;
    }
    if (raw === '--goal-complete') {
      parsed.goalComplete = true;
      continue;
    }
    if (raw === '--reason' || raw === '--remember' || raw === '--dir') {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) continue;
      if (raw === '--reason') parsed.reason = value;
      else if (raw === '--remember') parsed.remember = value;
      else parsed.dir = value;
      continue;
    }

    // `key=value` becomes an argument; a bare word is the tool name.
    const eq = raw.indexOf('=');
    if (eq > 0) {
      const key = raw.slice(0, eq);
      parsed.args[key] = coerce(raw.slice(eq + 1));
      continue;
    }
    if (parsed.tool === null) parsed.tool = raw;
  }

  return parsed;
}

/** Numbers, booleans, null, objects and arrays are parsed; everything else stays a string. */
export function coerce(value: string): unknown {
  if (value === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function main(): Promise<number> {
  const parsed = parseActArgs(process.argv.slice(2));

  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dir = resolve(parsed.dir);

  if (parsed.show) {
    const turn = await readIfPresent(join(dir, 'turn.json'));
    if (turn === null) {
      process.stderr.write(`No turn.json in ${dir}. Is the agent running with --control?\n`);
      return 1;
    }
    process.stdout.write(turn.endsWith('\n') ? turn : `${turn}\n`);
    return 0;
  }

  if (parsed.tool === null) {
    process.stderr.write(`No tool given.\n\n${USAGE}\n`);
    return 2;
  }

  const decision: Record<string, unknown> = {
    reason: parsed.reason || `manual: ${parsed.tool}`,
    tool: parsed.tool,
    arguments: parsed.args,
  };

  // Stamp the turn this answers, so an action written at the wrong moment is
  // discarded by the agent instead of being applied to a changed world.
  const turn = await readTurnNumber(join(dir, 'turn.json'));
  if (turn !== null) decision['turn'] = turn;
  if (parsed.remember !== undefined) decision['remember'] = parsed.remember;
  if (parsed.goalComplete) decision['goal_complete'] = true;

  await mkdir(dir, { recursive: true });
  const target = join(dir, 'action.json');
  await writeFile(target, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');

  process.stdout.write(`Wrote ${target}\n${JSON.stringify(decision)}\n`);
  return 0;
}

/** Reads the current turn number, if a turn has been published. */
async function readTurnNumber(path: string): Promise<number | null> {
  const content = await readIfPresent(path);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content) as { turn?: unknown };
    return typeof parsed.turn === 'number' ? parsed.turn : null;
  } catch {
    return null;
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Only run when invoked as a script. The parsing helpers above are imported by
 * tests, and importing a module must not execute the CLI.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return resolve(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
