import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LineSplitter,
  readPersistedSettings,
  writePersistedSettings,
  type RunSettings,
} from '../src/panel/process.js';

describe('LineSplitter', () => {
  function collect() {
    const seen: string[] = [];
    return { seen, splitter: new LineSplitter((line) => seen.push(line)) };
  }

  it('emits one item per complete line', () => {
    const { seen, splitter } = collect();
    splitter.push('a\nb\n');
    expect(seen).toEqual(['a', 'b']);
  });

  it('holds a partial line until its newline arrives', () => {
    const { seen, splitter } = collect();
    splitter.push('{"type":"cyc');
    expect(seen).toEqual([]);
    splitter.push('le"}\n');
    expect(seen).toEqual(['{"type":"cycle"}']);
  });

  it('handles a chunk with no trailing newline at all', () => {
    const { seen, splitter } = collect();
    splitter.push('one\ntwo');
    expect(seen).toEqual(['one']);
  });

  it('tolerates CRLF', () => {
    const { seen, splitter } = collect();
    splitter.push('one\r\n');
    expect(seen).toEqual(['one']);
  });

  it('skips blank lines', () => {
    const { seen, splitter } = collect();
    splitter.push('\n\nreal\n');
    expect(seen).toEqual(['real']);
  });

  it('reassembles an event split into three chunks', () => {
    const { seen, splitter } = collect();
    for (const piece of ['{"ty', 'pe":"cycl', 'e","cycle":4,"kind":"acted"}\n']) {
      splitter.push(piece);
    }
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]!)).toEqual({ type: 'cycle', cycle: 4, kind: 'acted' });
  });
});

describe('persisted settings', () => {
  const SETTINGS: RunSettings = {
    host: 'localhost',
    port: 25565,
    username: 'AI_Agent',
    auth: 'offline',
    goal: 'Gather wood',
    provider: 'jev',
    model: 'jev-1.13-free',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKey: 'zen-secret-key',
  };

  it('writes settings without the API key', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'panel-')), 'history.json');
    writePersistedSettings(path, SETTINGS);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('localhost');
    expect(written).toContain('Gather wood');
    expect(written).not.toContain('zen-secret-key');
    expect(written).not.toContain('apiKey');
  });

  it('round-trips the non-secret fields', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'panel-')), 'history.json');
    writePersistedSettings(path, SETTINGS);
    expect(readPersistedSettings(path)).toEqual({
      host: SETTINGS.host,
      port: SETTINGS.port,
      username: SETTINGS.username,
      auth: SETTINGS.auth,
      goal: SETTINGS.goal,
      provider: SETTINGS.provider,
      model: SETTINGS.model,
      baseUrl: SETTINGS.baseUrl,
    });
  });

  it('returns null for a missing or corrupt file rather than throwing', () => {
    expect(readPersistedSettings(join(tmpdir(), 'definitely-not-here.json'))).toBeNull();
    const path = join(mkdtempSync(join(tmpdir(), 'panel-')), 'bad.json');
    writeFileSync(path, '{ not json');
    expect(readPersistedSettings(path)).toBeNull();
  });
});

describe('event shapes', () => {
  it('parses every event the agent can emit', () => {
    const seen: unknown[] = [];
    const splitter = new LineSplitter((line) => seen.push(JSON.parse(line)));
    splitter.push(
      [
        '{"type":"lifecycle","status":"connected"}',
        '{"type":"world","cycle":1,"health":20,"food":20,"pos":{"x":1,"y":64,"z":2},"timeOfDay":"day","isDay":true,"inventory":[]}',
        '{"type":"decision","cycle":1,"tool":"mine","arguments":{},"reason":"r"}',
        '{"type":"result","cycle":1,"success":true,"durationMs":5}',
        '{"type":"cycle","cycle":1,"kind":"acted"}',
        '{"type":"notice","level":"warn","message":"careful"}',
      ].join('\n') + '\n',
    );
    expect(seen).toHaveLength(6);
  });

  it('reports a failed result with its error and details', () => {
    const seen: Array<Record<string, unknown>> = [];
    const splitter = new LineSplitter((line) => seen.push(JSON.parse(line)));
    splitter.push(
      '{"type":"result","cycle":2,"success":false,"error":"NO_PATH","details":"too far","durationMs":900}\n',
    );
    expect(seen[0]).toMatchObject({ success: false, error: 'NO_PATH', details: 'too far' });
  });
});

import { writeFileSync } from 'node:fs';