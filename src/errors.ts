/** Base class for every error thrown by this library. */
export class HlthstackBaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown for any non-2xx HTTP response.
 *
 * The API uses several error body shapes (see the errors guide), so the parsed body is kept
 * as-is in `body`, and `messages` holds a best-effort flat list of human-readable messages.
 */
export class HlthstackError extends HlthstackBaseError {
  /** HTTP status code. */
  readonly status: number;
  /** Parsed JSON body, or the raw text when the body is not JSON (e.g. `HTTP Token: Access denied.`). */
  readonly body: unknown;
  /** Response headers. */
  readonly headers: Headers;
  /** Request id from the response headers (`x-request-id`), when present. */
  readonly requestId: string | undefined;
  /** HTTP method of the failed request. */
  readonly method: string;
  /** Full URL of the failed request. */
  readonly url: string;
  /** Human-readable messages extracted from `body`. */
  readonly messages: string[];

  constructor(params: {
    status: number;
    body: unknown;
    headers: Headers;
    method: string;
    url: string;
  }) {
    const messages = extractErrorMessages(params.body);
    const summary = messages.length > 0 ? messages.join('; ') : 'Request failed';
    super(`${params.status} ${params.method} ${stripQuery(params.url)}: ${summary}`);
    this.status = params.status;
    this.body = params.body;
    this.headers = params.headers;
    this.requestId = params.headers.get('x-request-id') ?? undefined;
    this.method = params.method;
    this.url = params.url;
    this.messages = messages;
  }
}

/** Thrown when the request never got an HTTP response (network failure or timeout). */
export class HlthstackConnectionError extends HlthstackBaseError {
  readonly method: string;
  readonly url: string;
  /** True when the request was aborted by the client-side timeout. */
  readonly timedOut: boolean;

  constructor(params: { method: string; url: string; timedOut: boolean; cause?: unknown }) {
    super(
      params.timedOut
        ? `${params.method} ${stripQuery(params.url)} timed out`
        : `${params.method} ${stripQuery(params.url)} failed: ${describe(params.cause)}`,
      { cause: params.cause },
    );
    this.method = params.method;
    this.url = params.url;
    this.timedOut = params.timedOut;
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Flattens the API's error shapes into a list of messages:
 * `{errors: {field: [..]}}`, `{errors: {messages: [..]}}`, `{errors: [..]}`, `{message}`,
 * `{success: false, message}`, `{msg, recall}`, `{error}`, `{errors: {msg}}`, `{errors: {base}}`,
 * or a plain-text body.
 */
export function extractErrorMessages(body: unknown): string[] {
  if (typeof body === 'string') return body.trim() ? [body.trim()] : [];
  if (!isRecord(body)) return [];
  const out: string[] = [];
  const { errors } = body;
  if (Array.isArray(errors)) {
    out.push(...strings(errors));
  } else if (isRecord(errors)) {
    for (const [key, value] of Object.entries(errors)) {
      const list = strings(value);
      if (key === 'messages' || key === 'msg' || key === 'base') out.push(...list);
      else out.push(...list.map((m) => `${key}: ${m}`));
    }
  }
  out.push(...strings(body.message), ...strings(body.msg), ...strings(body.error));
  return out;
}
