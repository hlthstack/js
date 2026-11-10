import { HlthstackBaseError, HlthstackConnectionError, HlthstackError } from './errors.js';
import type { AccessToken } from './types.js';
import { VERSION } from './version.js';

export type Environment = 'production' | 'staging';

export const BASE_URLS: Record<Environment, string> = {
  production: 'https://api.hlthstack.io',
  staging: 'https://staging-api.hlthstack.io',
};

/** Refresh the cached token this long before its `expires_at`. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Used when `expires_at` cannot be parsed: the documented token lifetime. */
const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ClientOptions {
  /** Username issued by hlthstack. Required unless you only use pre-registration. */
  username?: string;
  /** Password issued by hlthstack. Required unless you only use pre-registration. */
  password?: string;
  /**
   * Pre-registration login (account email) issued by hlthstack. Separate from `username`;
   * needed only for `client.preRegistration.*`.
   */
  preRegistrationUsername?: string;
  /** Pre-registration password. Needed only for `client.preRegistration.*`. */
  preRegistrationPassword?: string;
  /** `production` (https://api.hlthstack.io) or `staging` (https://staging-api.hlthstack.io). */
  environment: Environment;
  /** Overrides the environment's base URL (for proxies or tests). */
  baseUrl?: string;
  /**
   * Multi-entity partners: the entity to act for, sent as `API-ENTITY-ID` on every call except
   * `get-access-token`. Requires `secretKey`. Omit to act for the entity tied to the credentials.
   */
  entityId?: string;
  /** Secret key shared at onboarding, sent as `API-SECRET-KEY` together with `API-ENTITY-ID`. */
  secretKey?: string;
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
}

export const TOKEN_PATH = '/api/get-access-token';
export const PRE_REGISTRATION_TOKEN_PATH = '/api/pre_registration/access-token';

/** Options accepted by every API method as the last argument. */
export interface RequestOptions {
  /**
   * Override the client's `entityId` for this call. Pass `null` to act for the entity tied to
   * the credentials (no entity headers).
   */
  entityId?: string | null;
  /** Override the client's `secretKey` for this call. */
  secretKey?: string;
  /** Abort the request. */
  signal?: AbortSignal;
  /** Override the client's timeout for this call. */
  timeoutMs?: number;
  /** Extra headers to send. */
  headers?: Record<string, string>;
}

type QueryValue = string | number | boolean | null | undefined | QueryValue[] | QueryObject;
interface QueryObject {
  [key: string]: QueryValue;
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: object;
  /** JSON body. */
  body?: unknown;
  /** Multipart body. */
  form?: FormData;
  /** `arrayBuffer` for binary responses such as voucher PDFs. Default `json`. */
  responseType?: 'json' | 'arrayBuffer';
  headers?: Record<string, string>;
}

interface CachedToken {
  token: AccessToken;
  refreshAt: number;
}

/** Encodes path segments: path`/api/appointments/${id}/voucher`. */
export function path(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce(
    (out, s, i) => out + s + (i < values.length ? encodeURIComponent(String(values[i])) : ''),
    '',
  );
}

/** Serialises query params. Nested objects use brackets: `customer_details[api_customer_id]`. */
export function buildQuery(query: object | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  const add = (key: string, value: QueryValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      params.append(key, value.filter((v) => v !== undefined && v !== null).join(','));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    } else {
      params.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(query)) add(key, value as QueryValue);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Caches one kind of access token and shares a pending request between concurrent callers. */
class TokenCache {
  private cached: CachedToken | undefined;
  private inflight: Promise<CachedToken> | undefined;

  constructor(private readonly fetchToken: () => Promise<AccessToken>) {}

  async get(options?: { forceRefresh?: boolean }): Promise<AccessToken> {
    if (!options?.forceRefresh && this.cached && Date.now() < this.cached.refreshAt) {
      return this.cached.token;
    }
    if (!this.inflight) {
      // Shared by concurrent callers, so it deliberately ignores any one caller's AbortSignal.
      this.inflight = this.fetchToken()
        .then((token) => {
          const expiresAt = Date.parse(token.expires_at);
          const expiry = Number.isFinite(expiresAt) ? expiresAt : Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
          this.cached = { token, refreshAt: expiry - TOKEN_REFRESH_MARGIN_MS };
          return this.cached;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return (await this.inflight).token;
  }

  /** Drops the cached token if it is the one that was just rejected. */
  invalidate(accessToken: string): void {
    if (this.cached?.token.access_token === accessToken) this.cached = undefined;
  }
}

/** HTTP transport: auth, entity headers, timeouts and error mapping. Internal. */
export class Transport {
  readonly environment: Environment;
  readonly baseUrl: string;
  private readonly entityId: string | undefined;
  private readonly secretKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokens: TokenCache;
  private readonly preRegistrationTokens: TokenCache;

  constructor(options: ClientOptions) {
    const partner = Boolean(options?.username && options.password);
    const preRegistration = Boolean(options?.preRegistrationUsername && options.preRegistrationPassword);
    if (!partner && !preRegistration) {
      throw new HlthstackBaseError(
        '`username` and `password` are required (or `preRegistrationUsername` and `preRegistrationPassword`)',
      );
    }
    if (!options.baseUrl && !(options.environment in BASE_URLS)) {
      throw new HlthstackBaseError("`environment` must be 'production' or 'staging'");
    }
    if (options.entityId && !options.secretKey) {
      throw new HlthstackBaseError('`secretKey` is required when `entityId` is set');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new HlthstackBaseError('No global `fetch` found; pass `fetch` in the options');
    }
    this.environment = options.environment;
    this.baseUrl = (options.baseUrl ?? BASE_URLS[options.environment]).replace(/\/+$/, '');
    this.entityId = options.entityId || undefined;
    this.secretKey = options.secretKey || undefined;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokens = new TokenCache(() =>
      this.fetchToken(TOKEN_PATH, options.username, options.password, '`username` and `password`'),
    );
    this.preRegistrationTokens = new TokenCache(() =>
      this.fetchToken(
        PRE_REGISTRATION_TOKEN_PATH,
        options.preRegistrationUsername,
        options.preRegistrationPassword,
        '`preRegistrationUsername` and `preRegistrationPassword`',
      ),
    );
  }

  /** Returns a valid access token, fetching one if none is cached or it is about to expire. */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<AccessToken> {
    return this.tokens.get(options);
  }

  /** The same for the pre-registration token (`GET /api/pre_registration/access-token`). */
  getPreRegistrationAccessToken(options?: { forceRefresh?: boolean }): Promise<AccessToken> {
    return this.preRegistrationTokens.get(options);
  }

  private async fetchToken(
    tokenPath: string,
    username: string | undefined,
    password: string | undefined,
    names: string,
  ): Promise<AccessToken> {
    if (!username || !password) {
      throw new HlthstackBaseError(`${names} are required for this call`);
    }
    return (await this.send(
      {
        method: 'GET',
        path: tokenPath,
        headers: { Authorization: `Basic ${base64(`${username}:${password}`)}` },
      },
      {},
    )) as AccessToken;
  }

  /** Authenticated API call. Refreshes the token and retries once on a 401. */
  async request<T>(req: ApiRequest, options: RequestOptions = {}): Promise<T> {
    const headers = { ...this.entityHeaders(options), ...req.headers, ...options.headers };
    return this.withToken(
      this.tokens,
      (token) => ({ ...headers, Authorization: `Bearer ${token}` }),
      req,
      options,
    );
  }

  /**
   * Pre-registration call: sends the pre-registration token as `X-EKINCARE-KEY` (no entity
   * headers). Refreshes the token and retries once on a 401.
   */
  async preRegistrationRequest<T>(req: ApiRequest, options: RequestOptions = {}): Promise<T> {
    const headers = { ...req.headers, ...options.headers };
    return this.withToken(
      this.preRegistrationTokens,
      (token) => ({ ...headers, 'X-EKINCARE-KEY': token }),
      req,
      options,
    );
  }

  private async withToken<T>(
    tokens: TokenCache,
    authHeaders: (token: string) => Record<string, string>,
    req: ApiRequest,
    options: RequestOptions,
  ): Promise<T> {
    let token = (await tokens.get()).access_token;
    try {
      return (await this.send({ ...req, headers: authHeaders(token) }, options)) as T;
    } catch (error) {
      if (!(error instanceof HlthstackError) || error.status !== 401) throw error;
      tokens.invalidate(token);
      token = (await tokens.get()).access_token;
      return (await this.send({ ...req, headers: authHeaders(token) }, options)) as T;
    }
  }

  private entityHeaders(options: RequestOptions): Record<string, string> {
    const entityId = options.entityId === undefined ? this.entityId : options.entityId;
    if (!entityId) return {};
    const secretKey = options.secretKey ?? this.secretKey;
    if (!secretKey) {
      throw new HlthstackBaseError('`secretKey` is required when `entityId` is set');
    }
    return { 'API-ENTITY-ID': entityId, 'API-SECRET-KEY': secretKey };
  }

  private async send(req: ApiRequest, options: RequestOptions): Promise<unknown> {
    const url = this.baseUrl + req.path + buildQuery(req.query);
    const headers: Record<string, string> = {
      Accept: req.responseType === 'arrayBuffer' ? 'application/pdf, application/json' : 'application/json',
      'User-Agent': `hlthstack-js/${VERSION}`,
      ...req.headers,
    };
    let body: BodyInit | undefined;
    if (req.form) {
      body = req.form; // fetch sets the multipart boundary
    } else if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? this.timeoutMs);
    const onAbort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: req.method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        if (options.signal?.aborted && !timedOut) throw cause;
        throw new HlthstackConnectionError({ method: req.method, url, timedOut, cause });
      }

      try {
        if (response.ok && req.responseType === 'arrayBuffer') {
          return await response.arrayBuffer();
        }
        const parsed = parseBody(await response.text());
        if (!response.ok) {
          throw new HlthstackError({
            status: response.status,
            body: parsed,
            headers: response.headers,
            method: req.method,
            url,
          });
        }
        return parsed;
      } catch (cause) {
        if (cause instanceof HlthstackError) throw cause;
        if (options.signal?.aborted && !timedOut) throw cause;
        throw new HlthstackConnectionError({ method: req.method, url, timedOut, cause });
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
