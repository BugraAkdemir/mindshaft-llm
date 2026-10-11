import type { AgentStreamEvent } from '../agent/events.js';

/** What the panel may send to a running agent. */
export type PanelCommand =
  | { type: 'guidance'; text: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

/** Anything with a `write`, so a test can pass a plain array collector. */
export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** One JSON object per line. A partial line must never be emitted. */
export function writeEvent(out: WritableLike, event: AgentStreamEvent): void {
  out.write(`${JSON.stringify(event)}\n`);
}

/**
 * Reads newline-delimited commands.
 *
 * Buffers across chunks, because a single write may split a command in half or
 * carry several at once — TCP and pipes both do this.
 */
export function readCommands(
  stdin: ReadableLike,
  onCommand: (command: PanelCommand) => void,
): void {
  let buffer = '';

  stdin.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') dispatch(line, onCommand);
      newline = buffer.indexOf('\n');
    }
  });
}

function dispatch(line: string, onCommand: (command: PanelCommand) => void): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A malformed line is the panel's bug; the run must survive it.
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;

  const candidate = parsed as { type?: unknown; text?: unknown };
  switch (candidate.type) {
    case 'pause':
      onCommand({ type: 'pause' });
      return;
    case 'resume':
      onCommand({ type: 'resume' });
      return;
    case 'stop':
      onCommand({ type: 'stop' });
      return;
    case 'guidance': {
      const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
      if (text !== '') onCommand({ type: 'guidance', text });
      return;
    }
    default:
  }
}