// The forge's HTTP server: one process serving git smart HTTP at /<owner>/<repo>.git, REST v3
// under /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp, all over one shared store.
// The boot probe /healthz answers without a token; every API surface requires the trial's
// bearer token (MAKEFUN_SHOP_TOKEN in the process environment).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Whether the request carries the trial's bearer token (any bearer when none is configured). */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  return /^Bearer \S+$/.test(header);
}

function nextRequestId(forge: Forge): string {
  forge.requestSeq += 1;
  return forge.requestSeq.toString(16).toUpperCase().padStart(8, '0');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const EMPTY_BODY = Buffer.alloc(0);
const EMPTY_QUERY: Record<string, string> = Object.freeze({});

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let body: Buffer = EMPTY_BODY;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
  const query: Record<string, string> = url.search === '' ? EMPTY_QUERY : Object.fromEntries(url.searchParams.entries());

  // The env's boot check calls this twice: 200 {"ok":true}, no token.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const isRest = segments[0] === 'api' && segments[1] === 'v3';
  const isGraphQL = segments[0] === 'api' && segments[1] === 'graphql';
  const isMcp = segments[0] === 'mcp';
  if ((isRest || isGraphQL || isMcp) && !authorized(req)) {
    const headers = isRest ? { 'X-GitHub-Request-Id': nextRequestId(forge) } : {};
    sendJson(res, 401, { message: 'Bad credentials' }, headers);
    return;
  }

  if (isRest) {
    const result = handleRest(forge, method, segments.slice(2), query, req.headers, body);
    const headers = { ...(result.headers ?? {}), 'X-GitHub-Request-Id': nextRequestId(forge) };
    if (result.value === null || result.status === 204) {
      res.writeHead(result.status, headers);
      res.end();
      return;
    }
    sendJson(res, result.status, result.value, headers);
    return;
  }

  if (isGraphQL) {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const result = handleGraphQL(forge, body);
    sendJson(res, result.status, result.value);
    return;
  }

  if (isMcp) {
    if (method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const result = handleMcp(forge, body);
    if (result.value === null) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    sendJson(res, result.status, result.value);
    return;
  }

  if (segments.length >= 2) {
    const gitResult = handleGit(forge, method, segments, query, req.headers, body);
    if (gitResult) {
      sendRaw(res, gitResult.status, gitResult.contentType, gitResult.body);
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(forge, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
