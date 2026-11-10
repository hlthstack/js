import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hlthstack, HlthstackBaseError, HlthstackError } from '../src/index.js';
import { TOKEN_PATH, json, makeClient, mockFetch, route, tokenResponse } from './helpers.js';

const providers = { 'GET /api/providers': () => json({ providers: [] }) };
const query = { service_name: 'ahc', package_ids: '1001', pincode: '500081' };

afterEach(() => {
  vi.useRealTimers();
});

describe('configuration', () => {
  it('uses the environment base URLs', () => {
    const { fetch } = mockFetch();
    expect(makeClient(fetch, { environment: 'production' }).baseUrl).toBe('https://api.hlthstack.io');
    expect(makeClient(fetch, { environment: 'staging' }).baseUrl).toBe('https://staging-api.hlthstack.io');
    expect(makeClient(fetch, { baseUrl: 'http://localhost:4010/' }).baseUrl).toBe('http://localhost:4010');
  });

  it('validates options', () => {
    const { fetch } = mockFetch();
    expect(() => makeClient(fetch, { username: '' })).toThrow(HlthstackBaseError);
    expect(() => makeClient(fetch, { environment: 'prod' as never })).toThrow(/environment/);
    expect(() => makeClient(fetch, { entityId: 'ENTITY-B' })).toThrow(/secretKey/);
  });
});

describe('access token', () => {
  it('fetches a token lazily with Basic auth and sends it as a Bearer token', async () => {
    const m = mockFetch(route(providers));
    const client = makeClient(m.fetch);
    expect(m.calls).toHaveLength(0);

    await client.appointments.listProviders(query);

    const [tokenCall, apiCall] = m.calls;
    expect(tokenCall?.url.toString()).toBe(`https://staging-api.hlthstack.io${TOKEN_PATH}`);
    expect(tokenCall?.method).toBe('GET');
    expect(tokenCall?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('example-user:example-password').toString('base64')}`,
    );
    expect(apiCall?.headers.get('authorization')).toBe('Bearer test-token-1');
    expect(apiCall?.headers.get('user-agent')).toMatch(/^hlthstack-js\//);
  });

  it('caches the token across calls', async () => {
    const m = mockFetch(route(providers));
    const client = makeClient(m.fetch);
    await client.appointments.listProviders(query);
    await client.appointments.listProviders(query);
    await client.appointments.listProviders(query);
    expect(m.tokenCalls()).toHaveLength(1);
    expect(m.apiCalls().map((c) => c.headers.get('authorization'))).toEqual([
      'Bearer test-token-1',
      'Bearer test-token-1',
      'Bearer test-token-1',
    ]);
  });

  it('refreshes shortly before expires_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T06:00:00Z'));
    let n = 0;
    const m = mockFetch(
      route({
        ...providers,
        [TOKEN_PATH]: () => {
          n += 1;
          return json({ access_token: `tok-${n}`, expires_at: '2026-01-15T07:00:00Z' });
        },
      }),
    );
    const client = makeClient(m.fetch);
    await client.appointments.listProviders(query);

    vi.setSystemTime(new Date('2026-01-15T06:54:00Z')); // 6 minutes left: still cached
    await client.appointments.listProviders(query);
    expect(m.tokenCalls()).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-15T06:56:00Z')); // 4 minutes left: refresh
    await client.appointments.listProviders(query);
    expect(m.tokenCalls()).toHaveLength(2);
    expect(m.apiCalls().at(-1)?.headers.get('authorization')).toBe('Bearer tok-2');
  });

  it('de-duplicates concurrent token requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = mockFetch(
      route({
        ...providers,
        [TOKEN_PATH]: async () => {
          await gate;
          return tokenResponse('shared-token');
        },
      }),
    );
    const client = makeClient(m.fetch);
    const pending = Promise.all([
      client.appointments.listProviders(query),
      client.wallet.listCustomerPlans('example-co', { api_customer_id: 'CUST1001' }),
      client.auth.getAccessToken(),
    ]);
    await Promise.resolve();
    release();
    const [, , token] = await pending;
    expect(m.tokenCalls()).toHaveLength(1);
    expect(token.access_token).toBe('shared-token');
    expect(m.apiCalls().every((c) => c.headers.get('authorization') === 'Bearer shared-token')).toBe(true);
  });

  it('refreshes the token and retries once on a 401', async () => {
    let attempts = 0;
    const m = mockFetch(
      route({
        'GET /api/providers': (call) => {
          attempts += 1;
          return call.headers.get('authorization') === 'Bearer test-token-1'
            ? new Response('HTTP Token: Access denied.', { status: 401 })
            : json({ providers: [{ provider_id: 1001 }] });
        },
      }),
    );
    const client = makeClient(m.fetch);
    const res = await client.appointments.listProviders(query);
    expect(res.providers[0]?.provider_id).toBe(1001);
    expect(attempts).toBe(2);
    expect(m.tokenCalls()).toHaveLength(2);
    expect(m.apiCalls()[1]?.headers.get('authorization')).toBe('Bearer test-token-2');
  });

  it('gives up after one retry', async () => {
    const m = mockFetch(
      route({ 'GET /api/providers': () => new Response('HTTP Token: Access denied.', { status: 401 }) }),
    );
    const client = makeClient(m.fetch);
    const error = await client.appointments.listProviders(query).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HlthstackError);
    expect((error as HlthstackError).status).toBe(401);
    expect((error as HlthstackError).body).toBe('HTTP Token: Access denied.');
    expect(m.apiCalls()).toHaveLength(2);
    expect(m.tokenCalls()).toHaveLength(2);
  });

  it('retries a multipart upload with the same form data', async () => {
    const bodies: unknown[] = [];
    const m = mockFetch(
      route({
        'POST /api/consultations/APT1A2B3C4D5/upload_documents': (call) => {
          bodies.push(call.body);
          return bodies.length === 1
            ? new Response('HTTP Token: Access denied.', { status: 401 })
            : json({ message: 'Document uploaded successfully' });
        },
      }),
    );
    const client = makeClient(m.fetch);
    await client.consultations.uploadDocuments('APT1A2B3C4D5', [
      { name: 'Report', file: { data: new Uint8Array([1]), filename: 'r.pdf' } },
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBeInstanceOf(FormData);
    expect((bodies[1] as FormData).get('files[][name]')).toBe('Report');
  });

  it('surfaces wrong credentials as a HlthstackError', async () => {
    const m = mockFetch(route({ [TOKEN_PATH]: () => json({ message: 'Wrong credentials' }, 401) }));
    const client = makeClient(m.fetch);
    const error = (await client.appointments.listProviders(query).catch((e: unknown) => e)) as HlthstackError;
    expect(error).toBeInstanceOf(HlthstackError);
    expect(error.status).toBe(401);
    expect(error.messages).toEqual(['Wrong credentials']);
    expect(m.apiCalls()).toHaveLength(0);
  });

  it('auth.getAccessToken returns the cached token unless forced', async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    expect((await client.auth.getAccessToken()).access_token).toBe('test-token-1');
    expect((await client.auth.getAccessToken()).access_token).toBe('test-token-1');
    expect((await client.auth.getAccessToken({ forceRefresh: true })).access_token).toBe('test-token-2');
  });
});

describe('entity headers', () => {
  it('sends API-ENTITY-ID and API-SECRET-KEY on API calls but not on get-access-token', async () => {
    const m = mockFetch(route(providers));
    const client = makeClient(m.fetch, { entityId: 'ENTITY-B', secretKey: 'example-secret-key' });
    await client.appointments.listProviders(query);
    const [tokenCall, apiCall] = m.calls;
    expect(tokenCall?.headers.has('api-entity-id')).toBe(false);
    expect(tokenCall?.headers.has('api-secret-key')).toBe(false);
    expect(apiCall?.headers.get('api-entity-id')).toBe('ENTITY-B');
    expect(apiCall?.headers.get('api-secret-key')).toBe('example-secret-key');
  });

  it('sends no entity headers by default', async () => {
    const m = mockFetch(route(providers));
    await makeClient(m.fetch).appointments.listProviders(query);
    expect(m.apiCalls()[0]?.headers.has('api-entity-id')).toBe(false);
    expect(m.apiCalls()[0]?.headers.has('api-secret-key')).toBe(false);
  });

  it('supports per-call overrides', async () => {
    const m = mockFetch(route(providers));
    const client = makeClient(m.fetch, { entityId: 'ENTITY-B', secretKey: 'example-secret-key' });
    await client.appointments.listProviders(query, { entityId: 'ENTITY-C' });
    await client.appointments.listProviders(query, { entityId: 'ENTITY-D', secretKey: 'other-key' });
    await client.appointments.listProviders(query, { entityId: null });
    const [c, d, none] = m.apiCalls();
    expect(c?.headers.get('api-entity-id')).toBe('ENTITY-C');
    expect(c?.headers.get('api-secret-key')).toBe('example-secret-key');
    expect(d?.headers.get('api-entity-id')).toBe('ENTITY-D');
    expect(d?.headers.get('api-secret-key')).toBe('other-key');
    expect(none?.headers.has('api-entity-id')).toBe(false);
    expect(none?.headers.has('api-secret-key')).toBe(false);
  });

  it('refuses a per-call entity id without a secret key', async () => {
    const m = mockFetch(route(providers));
    const client = makeClient(m.fetch);
    await expect(client.appointments.listProviders(query, { entityId: 'ENTITY-C' })).rejects.toThrow(
      /secretKey/,
    );
    expect(m.apiCalls()).toHaveLength(0);
  });
});

describe('exports', () => {
  it('exposes the client class', () => {
    expect(typeof Hlthstack).toBe('function');
  });
});
