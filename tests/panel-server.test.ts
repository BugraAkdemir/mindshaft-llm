import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPanelServer } from '../src/panel/server.js';
import type { AgentProcess, PanelSnapshot, RunSettings } from '../src/panel/process.js';
import type { PanelCommand } from '../src/panel/protocol.js';
import type { AgentStreamEvent } from '../src/agent/events.js';

const SETTINGS: RunSettings = {
  host: 'localhost',
  port: 25565,
  username: 'AI_Agent',
  auth: 'offline',
  goal: 'Gather wood',
  provider: 'jev',
  model: 'jev-1.13-free',
  baseUrl: 'https://opencode.ai/zen/v1',
  apiKey: 'zen-secret',
};

class FakeAgent {
  public readonly sent: PanelCommand[] = [];
  public readonly started: RunSettings[] = [];
  public listeners: Array<(event: AgentStreamEvent) => void> = [];
  public sendThrows = false;
  public startThrows = false;

  public on(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.push(listener);
    return () => undefined;
  }
  public start(settings: RunSettings): void {
    if (this.startThrows) throw new Error('an agent is already running');
    this.started.push(settings);
  }
  public send(command: PanelCommand): void {
    if (this.sendThrows) throw new Error('no agent is running');
    this.sent.push(command);
  }
  public stop(): void {}
  public get running(): boolean {
    return false;
  }
  public snapshot(): PanelSnapshot {
    return {
      running: false,
      exitCode: null,
      lifecycle: 'idle',
      lastWorld: null,
      recent: [],
      settings: null,
    };
  }
  public emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function boot(agent: FakeAgent, publicDir?: string) {
  const dir = publicDir ?? mkdtempSync(join(tmpdir(), 'panel-public-'));
  if (!publicDir) writeFileSync(join(dir, 'index.html'), '<h1>panel</h1>');
  const server = createPanelServer({ agent: agent as unknown as AgentProcess, publicDir: dir });
  const port = await server.listen(0, '127.0.0.1');
  open.push(() => server.close());
  return `http://127.0.0.1:${port}`;
}

const postJson = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('static files', () => {
  it('serves the page', async () => {
    const res = await fetch(`${await boot(new FakeAgent())}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('panel');
  });

  it('refuses to serve outside the public directory', async () => {
    const base = await boot(new FakeAgent());
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
  });

  it('404s an unknown file', async () => {
    expect((await fetch(`${await boot(new FakeAgent())}/nope.js`)).status).toBe(404);
  });
});

describe('GET /api/state', () => {
  it('returns a snapshot', async () => {
    const res = await fetch(`${await boot(new FakeAgent())}/api/state`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ running: false, lifecycle: 'idle' });
  });
});

describe('POST /api/start', () => {
  it('starts the agent with the given settings', async () => {
    const agent = new FakeAgent();
    const res = await postJson(await boot(agent), '/api/start', SETTINGS);
    expect(res.status).toBe(200);
    expect(agent.started[0]).toMatchObject({ host: 'localhost', provider: 'jev' });
  });

  it('reports 409 when the agent refuses to start', async () => {
    const agent = new FakeAgent();
    agent.startThrows = true;
    const res = await postJson(await boot(agent), '/api/start', SETTINGS);
    expect(res.status).toBe(409);
  });

  it('rejects a request that is not JSON', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const res = await fetch(`${base}/api/start`, { method: 'POST', body: 'host=x' });
    expect(res.status).toBe(415);
    expect(agent.started).toHaveLength(0);
  });

  it('rejects a cross-origin request', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const res = await postJson(base, '/api/start', SETTINGS, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(agent.started).toHaveLength(0);
  });

  it('accepts a same-origin request', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const res = await postJson(base, '/api/start', SETTINGS, { Origin: base });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed JSON body', async () => {
    const base = await boot(new FakeAgent());
    const res = await fetch(`${base}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ nope',
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown POST route', async () => {
    expect((await postJson(await boot(new FakeAgent()), '/api/nope', {})).status).toBe(404);
  });
});

describe('POST /api/command', () => {
  it('forwards guidance', async () => {
    const agent = new FakeAgent();
    const res = await postJson(await boot(agent), '/api/command', {
      type: 'guidance',
      text: 'Collect wood',
    });
    expect(res.status).toBe(200);
    expect(agent.sent).toEqual([{ type: 'guidance', text: 'Collect wood' }]);
  });

  it('forwards each control command', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    for (const type of ['pause', 'resume', 'stop']) {
      expect((await postJson(base, '/api/command', { type })).status).toBe(200);
    }
    expect(agent.sent).toEqual([{ type: 'pause' }, { type: 'resume' }, { type: 'stop' }]);
  });

  it('reports 409 when no agent is running', async () => {
    const agent = new FakeAgent();
    agent.sendThrows = true;
    const res = await postJson(await boot(agent), '/api/command', { type: 'pause' });
    expect(res.status).toBe(409);
  });

  it('rejects an unknown command type', async () => {
    const agent = new FakeAgent();
    const res = await postJson(await boot(agent), '/api/command', { type: 'selfdestruct' });
    expect(res.status).toBe(400);
    expect(agent.sent).toHaveLength(0);
  });

  it('rejects guidance with no text', async () => {
    const agent = new FakeAgent();
    const res = await postJson(await boot(agent), '/api/command', { type: 'guidance' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/events', () => {
  it('opens a stream, sends a snapshot, then live events', async () => {
    const agent = new FakeAgent();
    const base = await boot(agent);
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('event: message');
    expect(first).toContain('"lifecycle":"idle"');

    const pending = reader.read();
    agent.emit({ type: 'cycle', cycle: 7, kind: 'acted' });
    const second = decoder.decode((await pending).value);
    expect(second).toContain('"kind":"acted"');

    controller.abort();
  });
});

describe('the shipped page', () => {
  it('references the API it needs and loads its assets', async () => {
    const base = await boot(new FakeAgent(), resolve('src/panel/public'));

    const js = await (await fetch(`${base}/app.js`)).text();
    expect(js).toContain('/api/start');
    expect(js).toContain('/api/command');
    expect(js).toContain('/api/events');

    const css = await (await fetch(`${base}/style.css`)).text();
    expect(css).toContain('.feed');

    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('app.js');
    expect(html).toContain('style.css');
    expect(html).toContain('id="instruction"');
  });

  it('never hardcodes an API key into the page', () => {
    const html = readFileSync(resolve('src/panel/public/index.html'), 'utf8');
    expect(html).not.toMatch(/sk-or-v1-|zen-[A-Za-z0-9]{10}/);
  });
});