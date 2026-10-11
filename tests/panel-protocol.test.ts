import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readCommands, writeEvent, type PanelCommand } from '../src/panel/protocol.js';
import { EventBus } from '../src/agent/events.js';

function capture() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => chunks.push(s) };
}

describe('writeEvent', () => {
  it('writes one JSON object per line', () => {
    const out = capture();
    writeEvent(out, { type: 'cycle', cycle: 3, kind: 'acted' });
    writeEvent(out, { type: 'notice', level: 'info', message: 'hi' });
    expect(out.chunks).toHaveLength(2);
    for (const chunk of out.chunks) expect(chunk.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.chunks[0]!)).toEqual({ type: 'cycle', cycle: 3, kind: 'acted' });
  });
});

describe('readCommands', () => {
  function parse(chunks: string[]): PanelCommand[] {
    const stdin = new EventEmitter();
    const seen: PanelCommand[] = [];
    readCommands(stdin as never, (c) => seen.push(c));
    for (const chunk of chunks) stdin.emit('data', Buffer.from(chunk));
    return seen;
  }

  it('reads a complete command', () => {
    expect(parse(['{"type":"pause"}\n'])).toEqual([{ type: 'pause' }]);
  });

  it('waits for the newline when a command is split', () => {
    expect(parse(['{"type":"gui', 'dance","text":"go"}\n'])).toEqual([
      { type: 'guidance', text: 'go' },
    ]);
  });

  it('reads several commands from one chunk', () => {
    expect(parse(['{"type":"pause"}\n{"type":"stop"}\n'])).toEqual([
      { type: 'pause' },
      { type: 'stop' },
    ]);
  });

  it('accepts a buffer rather than a string', () => {
    const stdin = new EventEmitter();
    const seen: PanelCommand[] = [];
    readCommands(stdin as never, (c) => seen.push(c));
    stdin.emit('data', Buffer.from('{"type":"resume"}\n'));
    expect(seen).toEqual([{ type: 'resume' }]);
  });

  it('drops a malformed line instead of throwing', () => {
    expect(parse(['not json\n{"type":"stop"}\n'])).toEqual([{ type: 'stop' }]);
  });

  it('ignores guidance with no text', () => {
    expect(parse(['{"type":"guidance","text":"  "}\n', '{"type":"guidance"}\n'])).toEqual([]);
  });

  it('ignores an unknown command type', () => {
    expect(parse(['{"type":"selfdestruct"}\n'])).toEqual([]);
  });

  it('ignores a JSON value that is not an object', () => {
    expect(parse(['42\n"hello"\nnull\n'])).toEqual([]);
  });

  it('holds an unterminated command until more arrives', () => {
    expect(parse(['{"type":"stop"}'])).toEqual([]);
  });
});

describe('EventBus', () => {
  it('delivers events to every subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on((e) => seen.push(`a:${e.type}`));
    bus.on((e) => seen.push(`b:${e.type}`));
    bus.emit({ type: 'cycle', cycle: 1, kind: 'acted' });
    expect(seen).toEqual(['a:cycle', 'b:cycle']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on((e) => seen.push(e.type));
    off();
    bus.emit({ type: 'cycle', cycle: 1, kind: 'acted' });
    expect(seen).toEqual([]);
  });

  it('keeps notifying the others when one listener throws', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on((e) => seen.push(e.type));
    expect(() => bus.emit({ type: 'cycle', cycle: 1, kind: 'acted' })).not.toThrow();
    expect(seen).toEqual(['cycle']);
  });

  it('reports how many listeners are attached', () => {
    const bus = new EventBus();
    bus.on(() => undefined);
    bus.on(() => undefined);
    expect(bus.size).toBe(2);
  });

  it('is safe to unsubscribe from inside a listener', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on(() => off());
    bus.on((e) => seen.push(e.type));
    bus.emit({ type: 'cycle', cycle: 1, kind: 'acted' });
    bus.emit({ type: 'cycle', cycle: 2, kind: 'acted' });
    expect(seen).toEqual(['cycle', 'cycle']);
  });
});