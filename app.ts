// The forge's HTTP server: routing, auth, body reading, JSON discipline.
// Surfaces: /healthz, REST v3 under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp, git smart HTTP at /{owner}/{repo}.git. Everything else is a
// JSON 404. Every JSON reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { viewerLogin } from './scenario.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

/** The bearer token presented, or null when absent/malformed. */
function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(h);
  return m === null ? null : m[1];
}

export function createApp(): Server {
  const store = new Store();
  const viewer = viewerLogin();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, query } = pathOf(req);
      const method = req.method ?? 'GET';
      const token = bearerToken(req);
      const authed = shopToken === '' ? token !== null : token === shopToken;

      // Boot probe: no auth.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const rawBody = await readBody(req).catch(() => null);
      if (rawBody === null) {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
      if (gitMatch !== null) {
        if (!authed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        await handleGit(store, viewer, gitMatch[1], gitMatch[2], gitMatch[3] ?? '/', method, req.headers, rawBody, res, query.get('service') ?? undefined);
        return;
      }

      // GraphQL.
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authed) {
          res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
          res.end('{"message":"Requires authentication"}\n');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const run = (doc: { query?: unknown; variables?: unknown }): { data: unknown; errors: unknown[] } => {
          const out = executeGraphQL(
            typeof doc.query === 'string' ? doc.query : '',
            (typeof doc.variables === 'object' && doc.variables !== null ? doc.variables : {}) as Record<string, unknown>,
            { store, viewer },
          );
          return out;
        };
        if (Array.isArray(payload)) {
          sendJson(res, 200, payload.map(run));
        } else if (typeof payload === 'object' && payload !== null) {
          sendJson(res, 200, run(payload as { query?: unknown; variables?: unknown }));
        } else {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
        }
        return;
      }

      // MCP.
      if (pathname === '/mcp') {
        if (method === 'DELETE') {
          // Legacy session teardown: best-effort, always accepted.
          res.writeHead(202, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authed) {
          res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
          res.end('{"message":"Requires authentication"}\n');
          return;
        }
        const outcome = handleMcp({ store, viewer }, rawBody.toString('utf8'), req.headers['mcp-protocol-version'] as string | undefined);
        if (outcome.body === null) {
          res.writeHead(outcome.status, { 'x-github-request-id': nextRequestId(), ...(outcome.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
        return;
      }

      // REST v3.
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const segments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
        const needsAuth = !(method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta')));
        if (needsAuth && !authed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        let body: unknown;
        let bodyMalformed = false;
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString('utf8'));
          } catch {
            bodyMalformed = true;
          }
        }
        const result = handleRest({
          store,
          viewer,
          method,
          segments,
          query,
          body,
          bodyMalformed,
          host: typeof req.headers.host === 'string' ? req.headers.host : 'localhost',
        });
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      process.stderr.write(`[forge-error] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
