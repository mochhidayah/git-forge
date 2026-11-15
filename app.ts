// app.ts — HTTP server: routing, auth, body reading, JSON replies.
// Routes: /healthz, /mcp, /api/graphql, /api/v3/..., /<owner>/<repo>.git/...

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, checkAuth, nextRequestId, type RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcpRpc, mcpParseError } from './mcp.ts';
import {
  advertisementUploadV0,
  advertisementUploadV2,
  advertisementReceive,
  handleLsRefs,
  handleFetchV2,
  handleFetchV0,
  handleReceivePack,
  pushReportBytes,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const store = new Store();
const reqCounter = { n: 0 };
const expectedToken = process.env.MAKEFUN_SHOP_TOKEN && process.env.MAKEFUN_SHOP_TOKEN.length > 0
  ? process.env.MAKEFUN_SHOP_TOKEN
  : null;

const restCtx: RestContext = { store, expectedToken, reqCounter };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const requestId = nextRequestId(restCtx);
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(restCtx),
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const authed = checkAuth(restCtx, req.headers.authorization);

      // ---- MCP ------------------------------------------------------
      if (path === '/mcp') {
        if (method === 'DELETE') {
          sendJson(res, 200, {});
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authed) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          const err = mcpParseError();
          sendJson(res, err.status, err.payload);
          return;
        }
        const out = handleMcpRpc(store, (parsed.value ?? {}) as Record<string, unknown>);
        if (out.payload === null) {
          res.writeHead(out.status, { 'x-github-request-id': nextRequestId(restCtx) });
          res.end();
          return;
        }
        sendJson(res, out.status, out.payload);
        return;
      }

      // ---- GraphQL --------------------------------------------------
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authed) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const out = handleGraphQL({ store }, parsed.value);
        sendJson(res, out.status, out.payload);
        return;
      }

      // ---- REST v3 --------------------------------------------------
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const segments = segmentsOf(path.slice('/api/v3'.length));
        // Public: API root and meta.
        const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
        if (!isPublic && !authed) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        let body: unknown = {};
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Invalid JSON' });
              return;
            }
            body = parsed.value;
          }
        }
        const reqUrl = `http://${req.headers.host ?? 'entry'}${req.url ?? path}`;
        handleRest(restCtx, method, segments, query, body, (status, payload, extra) => sendJson(res, status, payload, extra ?? {}), reqUrl);
        return;
      }

      // ---- git smart HTTP -------------------------------------------
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1];
        const repoName = gitMatch[2];
        const rest = gitMatch[3] ?? '';
        if (!authed) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const repo = store.getRepo(owner, repoName);
        if (rest === '/info/refs') {
          const service = query.get('service') ?? '';
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const v2 = req.headers['git-protocol'] === 'version=2';
          if (service === 'git-upload-pack') {
            if (v2) sendBytes(res, 200, advertisementUploadV2(), 'application/x-git-upload-pack-advertisement');
            else sendBytes(res, 200, advertisementUploadV0(repo.git), 'application/x-git-upload-pack-advertisement');
            return;
          }
          if (service === 'git-receive-pack') {
            sendBytes(res, 200, advertisementReceive(repo.git), 'application/x-git-receive-pack-advertisement');
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (rest === '/git-upload-pack' && method === 'POST') {
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          try {
            const v2 = req.headers['git-protocol'] === 'version=2';
            // ls-refs is a v2 command inside the upload-pack body.
            const isLsRefs = raw.subarray(0, 64).includes(Buffer.from('command=ls-refs'));
            if (v2 && isLsRefs) {
              sendBytes(res, 200, handleLsRefs(repo.git, raw), 'application/x-git-upload-pack-result');
            } else if (v2) {
              sendBytes(res, 200, handleFetchV2(repo.git, raw), 'application/x-git-upload-pack-result');
            } else {
              sendBytes(res, 200, handleFetchV0(repo.git, raw), 'application/x-git-upload-pack-result');
            }
          } catch (err) {
            sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
          }
          return;
        }
        if (rest === '/git-receive-pack' && method === 'POST') {
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          try {
            const result = handleReceivePack(repo.git, raw);
            // The client negotiates side-band-64k whenever advertised; use it.
            const report = pushReportBytes(result, true);
            sendBytes(res, 200, report, 'application/x-git-receive-pack-result');
          } catch (err) {
            sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
          }
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // ---- anything else: GitHub's 404 body -------------------------
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // Response already gone.
      }
    });
  });
}
