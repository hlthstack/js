import { describe, expect, it } from 'vitest';
import { Hlthstack, HlthstackBaseError, HlthstackError } from '../src/index.js';
import {
  PRE_REGISTRATION_TOKEN_PATH,
  json,
  jsonBody,
  makeClient,
  mockFetch,
  route,
} from './helpers.js';

const accepted = { message: 'Request has been accepted', request_id: '3f2b8c1e-0d4a-4c5e-9b7a-2e6f1d8c9a01' };
const credentials = {
  preRegistrationUsername: 'hr@example.com',
  preRegistrationPassword: 'example-prereg-password',
};

const employee = {
  employee_code: 'EMP1001',
  company_id: '1001',
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane.doe@example.com',
  date_of_birth: '24-08-1990',
  gender: 'Female',
  mobile_number: '9999999999',
  vip: 'No',
  entity_name: '',
  employee_office_location: 'Hyderabad',
  department: 'Engineering',
  grade: 'B',
  date_of_joining: '01-01-2026',
  voluntary_plan_ids: ['EXAMPLE_PLAN', { plan_id: 'EXAMPLE_TOPUP', additional: true, subscription_id: 'ORD-0001' }],
};

const dependant = {
  guardian_email: 'jane.doe@example.com',
  dependent_code: 'DEP-001',
  first_name: 'John',
  last_name: 'Doe',
  date_of_birth: '10-02-1960',
  gender: 'Male',
  mobile_number: '9999999998',
  relation: 'Father',
};

function setup(routes: Parameters<typeof route>[0] = {}, options: Parameters<typeof makeClient>[1] = {}) {
  const m = mockFetch(route(routes));
  return { ...m, client: makeClient(m.fetch, { ...credentials, ...options }), last: () => m.apiCalls().at(-1)! };
}

describe('preRegistration', () => {
  it('uses its own token, sent as X-EKINCARE-KEY', async () => {
    const { client, calls, tokenCalls, preRegistrationTokenCalls, last } = setup({
      'POST /v1/corporate/pre_registrations': () => json(accepted),
    });
    const res = await client.preRegistration.create({ employees: [employee], dependants: [dependant] });
    expect(res).toEqual(accepted);

    expect(tokenCalls()).toHaveLength(0);
    expect(preRegistrationTokenCalls()).toHaveLength(1);
    const tokenCall = calls[0]!;
    expect(tokenCall.url.toString()).toBe(`https://staging-api.hlthstack.io${PRE_REGISTRATION_TOKEN_PATH}`);
    expect(tokenCall.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('hr@example.com:example-prereg-password').toString('base64')}`,
    );

    const call = last();
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/v1/corporate/pre_registrations');
    expect(call.headers.get('x-ekincare-key')).toBe('prereg-token-1');
    expect(call.headers.has('authorization')).toBe(false);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(await jsonBody(call)).toEqual({ employees: [employee], dependants: [dependant] });
  });

  it('update, deactivate and getStatus', async () => {
    const status = { request_id: accepted.request_id, status: 'completed', success_records: [], failure_records: [], created_at: '2026-01-15T06:16:21Z' };
    const { client, apiCalls, preRegistrationTokenCalls } = setup({
      'POST /v1/corporate/pre_registrations/update': () => json(accepted),
      'POST /v1/corporate/pre_registrations/deactivate': () => json(accepted),
      [`GET /v1/corporate/pre_registrations/${accepted.request_id}/status`]: () => json(status),
    });
    await client.preRegistration.update({ employees: [{ email: 'jane.doe@example.com', department: 'Finance' }] });
    await client.preRegistration.deactivate({ employees: ['jane.doe@example.com'], dependants: ['9999999998'] });
    expect(await client.preRegistration.getStatus(accepted.request_id)).toEqual(status);

    const [update, deactivate, get] = apiCalls();
    expect(await jsonBody(update)).toEqual({ employees: [{ email: 'jane.doe@example.com', department: 'Finance' }] });
    expect(await jsonBody(deactivate)).toEqual({ employees: ['jane.doe@example.com'], dependants: ['9999999998'] });
    expect(get?.method).toBe('GET');
    expect(get?.body).toBeUndefined();
    expect(preRegistrationTokenCalls()).toHaveLength(1);
  });

  it('never sends entity headers', async () => {
    const { client, last } = setup(
      { 'POST /v1/corporate/pre_registrations/deactivate': () => json(accepted) },
      { entityId: 'ENTITY-B', secretKey: 'example-secret-key' },
    );
    await client.preRegistration.deactivate({ employees: ['jane.doe@example.com'] });
    expect(last().headers.has('api-entity-id')).toBe(false);
    expect(last().headers.has('api-secret-key')).toBe(false);
  });

  it('keeps the partner and pre-registration tokens apart', async () => {
    const { client, last } = setup({
      'GET /api/providers': () => json({ providers: [] }),
      'POST /v1/corporate/pre_registrations/deactivate': () => json(accepted),
    });
    await client.appointments.listProviders({ service_name: 'ahc', package_ids: '1001', pincode: '500081' });
    expect(last().headers.get('authorization')).toBe('Bearer test-token-1');
    expect(last().headers.has('x-ekincare-key')).toBe(false);
    await client.preRegistration.deactivate({ employees: ['jane.doe@example.com'] });
    expect(last().headers.get('x-ekincare-key')).toBe('prereg-token-1');
    expect((await client.auth.getAccessToken()).access_token).toBe('test-token-1');
    expect((await client.preRegistration.getAccessToken()).access_token).toBe('prereg-token-1');
    expect((await client.preRegistration.getAccessToken({ forceRefresh: true })).access_token).toBe('prereg-token-2');
  });

  it('refreshes the token and retries once on an empty 401', async () => {
    let attempts = 0;
    const { client, preRegistrationTokenCalls, apiCalls } = setup({
      'POST /v1/corporate/pre_registrations/update': (call) => {
        attempts += 1;
        return call.headers.get('x-ekincare-key') === 'prereg-token-1'
          ? new Response(null, { status: 401 })
          : json(accepted);
      },
    });
    expect(await client.preRegistration.update({ employees: [{ email: 'jane.doe@example.com' }] })).toEqual(accepted);
    expect(attempts).toBe(2);
    expect(preRegistrationTokenCalls()).toHaveLength(2);
    expect(apiCalls()[1]?.headers.get('x-ekincare-key')).toBe('prereg-token-2');
  });

  it('parses the non-ISO expires_at and refreshes before it', async () => {
    let n = 0;
    const { client } = setup({
      [PRE_REGISTRATION_TOKEN_PATH]: () => {
        n += 1;
        const expires = new Date(Date.now() + (n === 1 ? 4 : 60) * 60 * 1000);
        const utc = expires.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
        return json({ access_token: `tok-${n}`, expires_at: utc });
      },
    });
    expect((await client.preRegistration.getAccessToken()).access_token).toBe('tok-1');
    // tok-1 expires in 4 minutes, inside the 5-minute margin: a new one is fetched.
    expect((await client.preRegistration.getAccessToken()).access_token).toBe('tok-2');
    expect((await client.preRegistration.getAccessToken()).access_token).toBe('tok-2');
  });

  it('surfaces 400 messages', async () => {
    const { client } = setup({
      'POST /v1/corporate/pre_registrations': () => json({ message: 'Request is too large' }, 400),
    });
    const error = (await client.preRegistration.create({ employees: [employee] }).catch((e: unknown) => e)) as HlthstackError;
    expect(error).toBeInstanceOf(HlthstackError);
    expect(error.status).toBe(400);
    expect(error.messages).toEqual(['Request is too large']);
  });

  it('works with pre-registration credentials only', async () => {
    const m = mockFetch(route({ 'POST /v1/corporate/pre_registrations/deactivate': () => json(accepted) }));
    const client = new Hlthstack({ ...credentials, environment: 'staging', fetch: m.fetch });
    await client.preRegistration.deactivate({ employees: ['jane.doe@example.com'] });
    await expect(client.wallet.listCustomerPlans('example-co', { api_customer_id: 'CUST1001' })).rejects.toThrow(
      /`username` and `password` are required/,
    );
    expect(m.tokenCalls()).toHaveLength(0);
  });

  it('needs pre-registration credentials for its calls', async () => {
    const m = mockFetch();
    const client = makeClient(m.fetch);
    await expect(client.preRegistration.getStatus(accepted.request_id)).rejects.toThrow(HlthstackBaseError);
    await expect(client.preRegistration.getAccessToken()).rejects.toThrow(/preRegistrationUsername/);
    expect(m.calls).toHaveLength(0);
  });
});
