import type { AgentStreamEvent } from '../agent/events.js';
import type { Agent } from '../agent/agent.js';
import type { ActionLoop } from '../agent/action-loop.js';
import { writeEvent, readCommands } from './protocol.js';

/** Anything with `write`, so a test can pass a plain array collector. */
export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/**
 * Wires the agent to the panel over its own stdio.
 *
 * This is why the process runs with `--panel`: pino is redirected to stderr by
 * the logger, so stdout carries nothing but these lines. A single stray
 * `console.log` anywhere in the agent would corrupt the stream, which is why
 * nothing in `src/` logs to stdout directly.
 */
export function startPanelBridge(agent: Agent, loop: ActionLoop): void {
  const stdout = process.stdout;
  const stdin = process.stdin;

  writeEvent(stdout, { type: 'lifecycle', status: 'connecting' });
  agent.onEvent((event: AgentStreamEvent) => writeEvent(stdout, event));

  // Commands arrive on stdin. An EPIPE here just means the panel went away,
  // so the error is swallowed rather than allowed to crash the run.
  stdin.on('error', () => undefined);
  readCommands(stdin, (command) => {
    switch (command.type) {
      case 'guidance':
        agent.queueGuidance(command.text);
        break;
      case 'pause':
        agent.setPaused(true);
        break;
      case 'resume':
        agent.setPaused(false);
        break;
      case 'stop':
        loop.requestStop('manual_stop', 'stopped from the control panel');
        // The loop only exists once the connection is up. Without this, a stop
        // pressed during a slow or failing connect would be ignored entirely.
        agent.stop('stopped from the control panel');
        break;
    }
  });
  stdin.resume();
}