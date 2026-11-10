// Plain-HTTP helpers for the hlthstack REST API: Node.js 18+ built-in fetch, no dependencies.
// Walkthrough: docs/api-integration.md
//
// Environment variables:
//   HLTHSTACK_BASE_URL        default https://staging-api.hlthstack.io
//   HLTHSTACK_USERNAME        API username
//   HLTHSTACK_PASSWORD        API password
//   HLTHSTACK_ENTITY_ID       optional, multi-entity partners
//   HLTHSTACK_SECRET_KEY      required with HLTHSTACK_ENTITY_ID
//   HLTHSTACK_PREREG_USERNAME pre-registration login (an email), only for pre-registration
//   HLTHSTACK_PREREG_PASSWORD

export const BASE_URL = process.env.HLTHSTACK_BASE_URL ?? 'https://staging-api.hlthstack.io';

const REFRESH_EARLY_MS = 5 * 60 * 1000; // renew 5 minutes before expires_at
const TOKEN_LIFETIME_MS = 60 * 60 * 1000; // tokens last 1 hour

/** Thrown for any non-2xx response. `body` is the parsed JSON, the text, or null. */
export class ApiError extends Error {
  constructor(status, body, requestId) {
    const messages = errorMessages(body);
    super(`HTTP ${status}: ${messages.join('; ') || 'no error message'}`);
    this.status = status;
    this.body = body;
    this.messages = messages;
    this.requestId = requestId;
  }
}

/** Flattens the API's error shapes into a list of strings. */
export function errorMessages(body) {
  if (body == null || body === '') return [];
  if (typeof body === 'string') return [body]; // e.g. 'HTTP Token: Access denied.'
  const out = [];
  const { errors } = body;
  if (Array.isArray(errors)) out.push(...errors.map(String)); // {errors: [...]}
  else if (errors && typeof errors === 'object') {
    for (const [field, value] of Object.entries(errors)) {
      if (field === 'messages' || field === 'base') out.push(...[value].flat().map(String)); // {errors: {messages: [...]}}
      else if (field === 'msg') out.push(String(value)); // {success: false, errors: {msg, recall}}
      else if (field !== 'recall') out.push(...[value].flat().map((m) => `${field}: ${m}`)); // {errors: {field: [...]}}
    }
  }
  for (const key of ['message', 'msg', 'error']) {
    if (typeof body[key] === 'string') out.push(body[key]); // {message}, {msg, recall}, {error}
  }
  return out;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `expires_at` is ISO 8601, or `2026-01-15 07:16:21 UTC` for pre-registration tokens. */
function parseExpiry(expiresAt) {
  const ms = Date.parse(String(expiresAt).replace(/^(\S+) (\S+) UTC$/, '$1T$2Z'));
  return Number.isNaN(ms) ? Date.now() + TOKEN_LIFETIME_MS : ms;
}

/**
 * Returns a getToken({ forceRefresh }) function for one token endpoint. The token is cached
 * until 5 minutes before it expires, and concurrent callers share one token request.
 */
function tokenCache(path, username, password) {
  let cached = null; // { token, expiresAt }
  let pending = null; // in-flight token request
  return async function getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cached && Date.now() < cached.expiresAt - REFRESH_EARLY_MS) return cached.token;
    pending ??= (async () => {
      if (!username || !password) throw new Error(`Set the credentials for ${path}`);
      const basic = Buffer.from(`${username}:${password}`).toString('base64');
      const res = await fetch(new URL(path, BASE_URL), { headers: { Authorization: `Basic ${basic}` } });
      if (!res.ok) throw new ApiError(res.status, await readBody(res), res.headers.get('x-request-id'));
      const { access_token, expires_at } = await res.json();
      cached = { token: access_token, expiresAt: parseExpiry(expires_at) };
      return access_token;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}

/** Booking API token: GET /api/get-access-token with HTTP Basic. */
export const getToken = tokenCache(
  '/api/get-access-token',
  process.env.HLTHSTACK_USERNAME,
  process.env.HLTHSTACK_PASSWORD,
);

/** Pre-registration token: its own credentials and endpoint. */
export const getPreRegistrationToken = tokenCache(
  '/api/pre_registration/access-token',
  process.env.HLTHSTACK_PREREG_USERNAME,
  process.env.HLTHSTACK_PREREG_PASSWORD,
);

/** Multi-entity partners: sent on every call except the token endpoints. */
function entityHeaders() {
  const entityId = process.env.HLTHSTACK_ENTITY_ID;
  if (!entityId) return {};
  return { 'API-ENTITY-ID': entityId, 'API-SECRET-KEY': process.env.HLTHSTACK_SECRET_KEY ?? '' };
}

async function request(method, path, options, getAuthHeaders) {
  const { query, body, form, headers = {}, binary = false } = options;
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const send = async (forceRefresh) =>
    fetch(url, {
      method,
      headers: {
        Accept: binary ? 'application/pdf, application/json' : 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }), // FormData sets its own
        ...(await getAuthHeaders(forceRefresh)),
        ...headers,
      },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(60_000),
    });

  let res = await send(false);
  if (res.status === 401) res = await send(true); // token expired or revoked: refresh once
  if (!res.ok) throw new ApiError(res.status, await readBody(res), res.headers.get('x-request-id'));
  return binary ? Buffer.from(await res.arrayBuffer()) : readBody(res);
}

/**
 * Calls the booking API with `Authorization: Bearer <token>`.
 * options: { query, body (JSON), form (FormData), headers, binary (return a Buffer) }
 */
export function api(method, path, options = {}) {
  return request(method, path, options, async (forceRefresh) => ({
    Authorization: `Bearer ${await getToken({ forceRefresh })}`,
    ...entityHeaders(),
  }));
}

/** Calls the pre-registration API with `X-EKINCARE-KEY: <token>` (no Bearer prefix). */
export function preRegistrationApi(method, path, options = {}) {
  return request(method, path, options, async (forceRefresh) => ({
    'X-EKINCARE-KEY': await getPreRegistrationToken({ forceRefresh }),
  }));
}
