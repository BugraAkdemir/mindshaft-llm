import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { AgentStreamEvent } from '../agent/events.js';
import type { AgentProcess, PanelSnapshot } from './process.js';
import type { PanelCommand } from './protocol.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** A body larger than this is not something this panel ever needs. */
const MAX_BODY_BYTES = 64 * 1024;

const COMMAND_TYPES = new Set(['guidance', 'pause', 'resume', 'stop']);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Refuses cross-origin writes.
 *
 * A `POST` with a simple content type can be sent from any web page the user
 * visits, so without this a random site could start and steer the bot through
 * their browser. A missing `Origin` is allowed: that is curl, or the test
 * client, neither of which a hostile page can impersonate.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

function toCommand(body: unknown): PanelCommand | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as { type?: unknown; text?: unknown };
  if (typeof candidate.type !== 'string' || !COMMAND_TYPES.has(candidate.type)) return null;
  if (candidate.type === 'guidance') {
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    return text === '' ? null : { type: 'guidance', text };
  }
  return { type: candidate.type } as PanelCommand;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The panel's HTTP surface: three API routes and the static page. No
 * framework, because three routes do not need one.
 */
export function createPanelServer(deps: {
  agent: AgentProcess;
  publicDir: string;
}): { listen(port: number, host: string): Promise<number>; close(): Promise<void> } {
  const root = resolve(deps.publicDir);
  const clients = new Set<ServerResponse>();

  deps.agent.on((event: AgentStreamEvent) => {
    const frame = `event: message\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: message(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // The first frame carries the snapshot, so a fresh page paints without
      // waiting for the next cycle.
      const snapshot: PanelSnapshot = deps.agent.snapshot();
      res.write(`event: message\ndata: ${JSON.stringify(snapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (path === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, deps.agent.snapshot());
      return;
    }

    if (req.method === 'POST') {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'expected application/json' });
        return;
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: 'cross-origin request refused' });
        return;
      }

      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        sendJson(res, 400, { error: message(err) });
        return;
      }

      if (path === '/api/start') {
        try {
          deps.agent.start(body as never);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 409, { error: message(err) });
        }
        return;
      }

      if (path === '/api/command') {
        const command = toCommand(body);
        if (!command) {
          sendJson(res, 400, { error: 'unknown command' });
          return;
        }
        try {
          deps.agent.send(command);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 409, { error: message(err) });
        }
        return;
      }

      sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const target = resolve(join(root, normalize(relative)));
    if (target !== root && !target.startsWith(root + sep)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!existsSync(target)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(target));
  }

  return {
    listen(port, host) {
      return new Promise((resolvePort, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolvePort(typeof address === 'object' && address !== null ? address.port : port);
        });
      });
    },
    close() {
      for (const client of clients) client.end();
      clients.clear();
      return new Promise((done) => server.close(() => done()));
    },
  };
}