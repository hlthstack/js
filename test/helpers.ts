import { Hlthstack, type ClientOptions } from '../src/index.js';

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export const TOKEN_PATH = '/api/get-access-token';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function tokenResponse(token = 'test-token-1', expiresInMs = 60 * 60 * 1000): Response {
  return json({ access_token: token, expires_at: new Date(Date.now() + expiresInMs).toISOString() });
}

/**
 * A mock fetch. Token requests are answered automatically (token-1, token-2, ...) unless the
 * handler deals with them; every call is recorded.
 */
export function mockFetch(handler: Handler = route({})) {
  const calls: RecordedCall[] = [];
  let tokens = 0;
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call: RecordedCall = {
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
    };
    calls.push(call);
    if (call.url.pathname === TOKEN_PATH) {
      const custom = await handler(call);
      if (custom.status !== 418) return custom;
      tokens += 1;
      return tokenResponse(`test-token-${tokens}`);
    }
    return handler(call);
  };
  const apiCalls = () => calls.filter((c) => c.url.pathname !== TOKEN_PATH);
  const tokenCalls = () => calls.filter((c) => c.url.pathname === TOKEN_PATH);
  return { fetch: fetch as typeof globalThis.fetch, calls, apiCalls, tokenCalls };
}

/** Use as the handler's answer for token requests to fall back to the automatic tokens. */
export const AUTO_TOKEN = () => new Response(null, { status: 418 });

export function route(routes: Record<string, Handler>, fallback: Handler = () => json({})): Handler {
  return (call) => {
    if (call.url.pathname === TOKEN_PATH) return (routes[TOKEN_PATH] ?? AUTO_TOKEN)(call);
    const key = `${call.method} ${call.url.pathname}`;
    return (routes[key] ?? fallback)(call);
  };
}

export function makeClient(fetch: typeof globalThis.fetch, options: Partial<ClientOptions> = {}) {
  return new Hlthstack({
    username: 'example-user',
    password: 'example-password',
    environment: 'staging',
    fetch,
    ...options,
  });
}

export async function jsonBody(call: RecordedCall | undefined): Promise<unknown> {
  if (!call) throw new Error('no call');
  return JSON.parse(String(call.body));
}
