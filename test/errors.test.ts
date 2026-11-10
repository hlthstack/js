import { describe, expect, it } from 'vitest';
import { HlthstackConnectionError, HlthstackError, extractErrorMessages } from '../src/index.js';
import { json, makeClient, mockFetch, route } from './helpers.js';

const query = { service_name: 'ahc' as const, package_ids: '1001', pincode: '500081' };

async function failWith(response: () => Response): Promise<HlthstackError> {
  const m = mockFetch(route({ 'GET /api/providers': response }));
  const error = await makeClient(m.fetch)
    .appointments.listProviders(query)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HlthstackError);
  return error as HlthstackError;
}

describe('HlthstackError', () => {
  it('keeps status, parsed body, headers and request id', async () => {
    const body = { errors: { service_name: ["can't be blank"], package_ids: ['should be an integer array'] } };
    const error = await failWith(() => json(body, 400, { 'X-Request-Id': 'req-123' }));
    expect(error.status).toBe(400);
    expect(error.body).toEqual(body);
    expect(error.requestId).toBe('req-123');
    expect(error.headers.get('content-type')).toBe('application/json');
    expect(error.method).toBe('GET');
    expect(error.url).toContain('/api/providers?');
    expect(error.messages).toEqual(["service_name: can't be blank", 'package_ids: should be an integer array']);
    expect(error.message).toBe(
      "400 GET https://staging-api.hlthstack.io/api/providers: service_name: can't be blank; package_ids: should be an integer array",
    );
  });

  it('maps every documented error shape', () => {
    expect(extractErrorMessages({ errors: { messages: ['This booking cannot be rescheduled'] } })).toEqual([
      'This booking cannot be rescheduled',
    ]);
    expect(extractErrorMessages({ message: 'Required details are missing' })).toEqual([
      'Required details are missing',
    ]);
    expect(extractErrorMessages({ errors: ['Invalid status'] })).toEqual(['Invalid status']);
    expect(extractErrorMessages({ success: false, message: 'Order not found' })).toEqual(['Order not found']);
    expect(extractErrorMessages({ msg: 'Slot not available', recall: false })).toEqual(['Slot not available']);
    expect(extractErrorMessages({ error: 'Invalid company slug for authenticated partner.' })).toEqual([
      'Invalid company slug for authenticated partner.',
    ]);
    expect(
      extractErrorMessages({ success: false, errors: { msg: 'Pharmacy benefit not enabled for this plan', recall: false } }),
    ).toEqual(['Pharmacy benefit not enabled for this plan']);
    expect(
      extractErrorMessages({ success: false, status: 'transaction_locked', errors: { base: 'Transaction is locked' } }),
    ).toEqual(['Transaction is locked']);
    expect(extractErrorMessages('HTTP Token: Access denied.')).toEqual(['HTTP Token: Access denied.']);
    expect(extractErrorMessages(undefined)).toEqual([]);
  });

  it('handles non-JSON and empty bodies', async () => {
    const html = await failWith(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(html.status).toBe(502);
    expect(html.body).toBe('<html>Bad gateway</html>');
    const empty = await failWith(() => new Response(null, { status: 500 }));
    expect(empty.body).toBeUndefined();
    expect(empty.messages).toEqual([]);
  });

  it('throws for JSON error bodies on binary endpoints', async () => {
    const m = mockFetch(
      route({
        'GET /api/appointments/APT1A2B3C4D5/voucher': () =>
          json({ errors: { messages: ['voucher only available for download when appointment is confirmed'] } }, 400),
      }),
    );
    const error = (await makeClient(m.fetch)
      .appointments.getVoucher('APT1A2B3C4D5')
      .catch((e: unknown) => e)) as HlthstackError;
    expect(error.status).toBe(400);
    expect(error.messages).toEqual(['voucher only available for download when appointment is confirmed']);
  });

  it('does not throw on 2xx bodies with success: false', async () => {
    const m = mockFetch(
      route({
        'GET /api/epharmacy/fulfillment_options': () =>
          json({ success: true, delivery_options: { success: false }, pickup_options: { success: false } }),
      }),
    );
    const res = await makeClient(m.fetch).pharmacy.getFulfillmentOptions({
      customer_details: { api_customer_id: 'CUST1001' },
      cart_id: 701,
    });
    expect(res.delivery_options?.success).toBe(false);
  });
});

describe('connection errors', () => {
  it('wraps network failures', async () => {
    const m = mockFetch(
      route({
        'GET /api/providers': () => {
          throw new TypeError('fetch failed');
        },
      }),
    );
    const error = (await makeClient(m.fetch)
      .appointments.listProviders(query)
      .catch((e: unknown) => e)) as HlthstackConnectionError;
    expect(error).toBeInstanceOf(HlthstackConnectionError);
    expect(error.timedOut).toBe(false);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('times out', async () => {
    const hang = (signal?: AbortSignal | null) =>
      new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    const m = mockFetch();
    const fetch: typeof globalThis.fetch = (input, init) =>
      String(input).includes('get-access-token') ? m.fetch(input, init) : hang(init?.signal);
    const error = (await makeClient(fetch, { timeoutMs: 20 })
      .appointments.listProviders(query)
      .catch((e: unknown) => e)) as HlthstackConnectionError;
    expect(error).toBeInstanceOf(HlthstackConnectionError);
    expect(error.timedOut).toBe(true);
  });

  it('rethrows a caller abort as-is', async () => {
    const m = mockFetch();
    const fetch: typeof globalThis.fetch = (input, init) =>
      String(input).includes('get-access-token')
        ? m.fetch(input, init)
        : new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const controller = new AbortController();
    const pending = makeClient(fetch).appointments.listProviders(query, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller aborted')), 5);
    await expect(pending).rejects.toThrow('caller aborted');
  });
});
