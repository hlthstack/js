import { Hlthstack, type ClientOptions } from '../src/index.js';

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

export const TOKEN_PATH = '/api/get-access-token';
export const PRE_REGISTRATION_TOKEN_PATH = '/api/pre_registration/access-token';
const TOKEN_PATHS = [TOKEN_PATH, PRE_REGISTRATION_TOKEN_PATH];

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
 * A mock fetch. Token requests are answered automatically (test-token-1, test-token-2, ...;
 * pre-registration: prereg-token-1, ...) unless the handler deals with them; every call is
 * recorded.
 */
export function mockFetch(handler: Handler = route({})) {
  const calls: RecordedCall[] = [];
  let tokens = 0;
  let preRegistrationTokens = 0;
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call: RecordedCall = {
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
    };
    calls.push(call);
    if (TOKEN_PATHS.includes(call.url.pathname)) {
      const custom = await handler(call);
      if (custom.status !== 418) return custom;
      if (call.url.pathname === TOKEN_PATH) {
        tokens += 1;
        return tokenResponse(`test-token-${tokens}`);
      }
      preRegistrationTokens += 1;
      return tokenResponse(`prereg-token-${preRegistrationTokens}`);
    }
    return handler(call);
  };
  const apiCalls = () => calls.filter((c) => !TOKEN_PATHS.includes(c.url.pathname));
  const tokenCalls = () => calls.filter((c) => c.url.pathname === TOKEN_PATH);
  const preRegistrationTokenCalls = () =>
    calls.filter((c) => c.url.pathname === PRE_REGISTRATION_TOKEN_PATH);
  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    apiCalls,
    tokenCalls,
    preRegistrationTokenCalls,
  };
}

/** Use as the handler's answer for token requests to fall back to the automatic tokens. */
export const AUTO_TOKEN = () => new Response(null, { status: 418 });

export function route(routes: Record<string, Handler>, fallback: Handler = () => json({})): Handler {
  return (call) => {
    if (TOKEN_PATHS.includes(call.url.pathname)) return (routes[call.url.pathname] ?? AUTO_TOKEN)(call);
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
