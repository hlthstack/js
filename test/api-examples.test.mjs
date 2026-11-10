// Runs the plain-fetch examples in examples/api/ against a local HTTP server and checks every
// request they send. Plain JavaScript (like the examples), so `tsc` does not check this file.
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USERNAME = 'example-user';
const PASSWORD = 'example-password';
const PREREG_USERNAME = 'prereg@example.com';
const PREREG_PASSWORD = 'example-prereg-password';
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

const ENV_KEYS = [
  'HLTHSTACK_BASE_URL', 'HLTHSTACK_USERNAME', 'HLTHSTACK_PASSWORD', 'HLTHSTACK_ENTITY_ID',
  'HLTHSTACK_SECRET_KEY', 'HLTHSTACK_PREREG_USERNAME', 'HLTHSTACK_PREREG_PASSWORD', 'PRESCRIPTION_FILE',
];

// ------------------------------------------------------------------ mock server

let server;
let baseUrl;
let calls;
let routes;
let tokens;

const isTokenPath = (path) => path === '/api/get-access-token' || path === '/api/pre_registration/access-token';
const apiCalls = () => calls.filter((c) => !isTokenPath(c.path));
const tokenCalls = (path = '/api/get-access-token') => calls.filter((c) => c.path === path);
const expiresIn = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const defaultRoutes = () => ({
  'GET /api/get-access-token': () => ({ json: { access_token: `token-${++tokens.api}`, expires_at: expiresIn(3600e3) } }),
  // Pre-registration tokens use `YYYY-MM-DD HH:MM:SS UTC`.
  'GET /api/pre_registration/access-token': () => ({
    json: {
      access_token: `prereg-token-${++tokens.preRegistration}`,
      expires_at: expiresIn(3600e3).replace('T', ' ').replace('Z', ' UTC'),
    },
  }),
});

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://localhost');
    const contentType = req.headers['content-type'] ?? '';
    const call = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      raw,
    };
    if (contentType.startsWith('application/json')) call.json = JSON.parse(raw.toString('utf8'));
    if (contentType.startsWith('multipart/form-data')) {
      call.form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': contentType }, body: raw }).formData();
    }
    calls.push(call);
    const handler = routes[`${req.method} ${url.pathname}`];
    const out = handler ? await handler(call) : { status: 404, json: { message: `no mock for ${req.method} ${url.pathname}` } };
    const headers = { ...out.headers };
    let body = '';
    if (out.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(out.json);
    } else if (out.buffer !== undefined) {
      headers['content-type'] = 'application/pdf';
      body = out.buffer;
    } else if (out.text !== undefined) {
      headers['content-type'] = 'text/plain';
      body = out.text;
    }
    res.writeHead(out.status ?? 200, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  calls = [];
  tokens = { api: 0, preRegistration: 0 };
  routes = defaultRoutes();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HLTHSTACK_BASE_URL = baseUrl;
  process.env.HLTHSTACK_USERNAME = USERNAME;
  process.env.HLTHSTACK_PASSWORD = PASSWORD;
  process.env.HLTHSTACK_PREREG_USERNAME = PREREG_USERNAME;
  process.env.HLTHSTACK_PREREG_PASSWORD = PREREG_PASSWORD;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules(); // fresh token caches; env is read when the examples load
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

const loadClient = () => import('../examples/api/client.mjs');
const runExample = (name) => import(`../examples/api/${name}.mjs`);

// ------------------------------------------------------------------ client.mjs

describe('client.mjs', () => {
  it('gets a token with Basic auth, then sends it as a Bearer token', async () => {
    routes['GET /api/providers'] = () => ({ json: { providers: [] } });
    const { api, BASE_URL } = await loadClient();
    expect(BASE_URL).toBe(baseUrl);

    expect(await api('GET', '/api/providers', { query: { service_name: 'ahc', package_ids: '1001', pincode: '500081' } }))
      .toEqual({ providers: [] });

    const [token, call] = calls;
    expect(token.method).toBe('GET');
    expect(token.path).toBe('/api/get-access-token');
    expect(token.headers.authorization).toBe(basic(USERNAME, PASSWORD));
    expect(call.headers.authorization).toBe('Bearer token-1');
    expect(call.query).toEqual({ service_name: 'ahc', package_ids: '1001', pincode: '500081' });
    expect(call.headers['api-entity-id']).toBeUndefined();
  });

  it('caches the token and shares one token request between concurrent calls', async () => {
    routes['GET /api/epharmacy/cart'] = () => ({ json: { success: true, cart: {} } });
    const { api } = await loadClient();
    await Promise.all([1, 2, 3].map(() => api('GET', '/api/epharmacy/cart')));
    await api('GET', '/api/epharmacy/cart');
    expect(tokenCalls()).toHaveLength(1);
    expect(apiCalls().map((c) => c.headers.authorization)).toEqual(Array(4).fill('Bearer token-1'));
  });

  it('renews the token 5 minutes before expires_at', async () => {
    routes['GET /api/get-access-token'] = () => ({
      json: { access_token: `token-${++tokens.api}`, expires_at: expiresIn(4 * 60e3) },
    });
    routes['GET /api/epharmacy/cart'] = () => ({ json: {} });
    const { api } = await loadClient();
    await api('GET', '/api/epharmacy/cart');
    await api('GET', '/api/epharmacy/cart');
    expect(tokenCalls()).toHaveLength(2);
    expect(apiCalls()[1].headers.authorization).toBe('Bearer token-2');
  });

  it('refreshes the token once on 401 and retries', async () => {
    let first = true;
    routes['GET /api/epharmacy/cart'] = () => {
      if (first) {
        first = false;
        return { status: 401, text: 'HTTP Token: Access denied.' };
      }
      return { json: { success: true } };
    };
    const { api } = await loadClient();
    expect(await api('GET', '/api/epharmacy/cart')).toEqual({ success: true });
    expect(tokenCalls()).toHaveLength(2);
    expect(apiCalls().map((c) => c.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('gives up after one retry on a second 401', async () => {
    routes['GET /api/epharmacy/cart'] = () => ({ status: 401, text: 'HTTP Token: Access denied.' });
    const { api, ApiError } = await loadClient();
    const error = await api('GET', '/api/epharmacy/cart').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.messages).toEqual(['HTTP Token: Access denied.']);
    expect(apiCalls()).toHaveLength(2);
  });

  it('throws ApiError with the parsed body, flattened messages and request id', async () => {
    routes['PATCH /api/appointments/APT1A2B3C4D5/reschedule'] = () => ({
      status: 400,
      headers: { 'x-request-id': 'req-123' },
      json: { errors: { messages: ['This appointment cannot be rescheduled'] } },
    });
    const { api, ApiError } = await loadClient();
    const error = await api('PATCH', '/api/appointments/APT1A2B3C4D5/reschedule', {
      body: { appointment_date_time: '2030-01-16T02:30:00Z' },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.body).toEqual({ errors: { messages: ['This appointment cannot be rescheduled'] } });
    expect(error.messages).toEqual(['This appointment cannot be rescheduled']);
    expect(error.requestId).toBe('req-123');
    expect(error.message).toBe('HTTP 400: This appointment cannot be rescheduled');
    const call = apiCalls()[0];
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.json).toEqual({ appointment_date_time: '2030-01-16T02:30:00Z' });
  });

  it('throws when the token request fails', async () => {
    routes['GET /api/get-access-token'] = () => ({ status: 401, json: { message: 'Wrong credentials' } });
    const { api, ApiError } = await loadClient();
    const error = await api('GET', '/api/providers').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.messages).toEqual(['Wrong credentials']);
    expect(apiCalls()).toHaveLength(0);
  });

  it('flattens every documented error shape', async () => {
    const { errorMessages } = await loadClient();
    expect(errorMessages({ errors: { package_ids: ['should be an integer array'] } })).toEqual(['package_ids: should be an integer array']);
    expect(errorMessages({ errors: { messages: ['This booking cannot be rescheduled'] } })).toEqual(['This booking cannot be rescheduled']);
    expect(errorMessages({ message: 'Required details are missing' })).toEqual(['Required details are missing']);
    expect(errorMessages({ errors: ['Invalid status'] })).toEqual(['Invalid status']);
    expect(errorMessages({ success: false, message: 'Order not found' })).toEqual(['Order not found']);
    expect(errorMessages({ msg: 'Booking failed', recall: false })).toEqual(['Booking failed']);
    expect(errorMessages({ error: 'Invalid company slug for authenticated partner.' })).toEqual(['Invalid company slug for authenticated partner.']);
    expect(errorMessages({ success: false, errors: { msg: 'Pharmacy benefit not enabled for this plan', recall: false } }))
      .toEqual(['Pharmacy benefit not enabled for this plan']);
    expect(errorMessages({ status: 'invalid_payment', errors: { base: ['Amount mismatch'] } })).toEqual(['Amount mismatch']);
    expect(errorMessages('HTTP Token: Access denied.')).toEqual(['HTTP Token: Access denied.']);
    expect(errorMessages(null)).toEqual([]);
  });

  it('sends the entity headers on API calls but not on the token call', async () => {
    process.env.HLTHSTACK_ENTITY_ID = 'ENTITY_B_ID';
    process.env.HLTHSTACK_SECRET_KEY = 'example-secret-key';
    routes['GET /api/providers'] = () => ({ json: { providers: [] } });
    const { api } = await loadClient();
    await api('GET', '/api/providers');
    await api('GET', '/api/providers', { headers: { 'API-ENTITY-ID': 'ENTITY_C_ID' } });

    const [token] = tokenCalls();
    expect(token.headers['api-entity-id']).toBeUndefined();
    expect(token.headers['api-secret-key']).toBeUndefined();
    const [first, second] = apiCalls();
    expect(first.headers['api-entity-id']).toBe('ENTITY_B_ID');
    expect(first.headers['api-secret-key']).toBe('example-secret-key');
    expect(second.headers['api-entity-id']).toBe('ENTITY_C_ID');
  });

  it('returns binary responses as a Buffer', async () => {
    routes['GET /api/appointments/APT1A2B3C4D5/voucher'] = () => ({ buffer: Buffer.from('%PDF-1.4 example') });
    const { api } = await loadClient();
    const pdf = await api('GET', '/api/appointments/APT1A2B3C4D5/voucher', { binary: true });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.toString()).toBe('%PDF-1.4 example');
    expect(apiCalls()[0].headers.accept).toBe('application/pdf, application/json');
  });
});

// ------------------------------------------------------------------ book-health-checkup.mjs

describe('book-health-checkup.mjs', () => {
  const slot = (time, available = true) => ({ utc_slot_time: time, available });
  let voucherFile;
  afterEach(async () => {
    if (voucherFile) await rm(voucherFile, { force: true });
  });

  it('lists providers and slots, books, reads, reschedules, downloads the voucher and cancels', async () => {
    routes['GET /api/providers'] = () => ({ json: { providers: [{ provider_id: 1001, home_collection_enabled: true }] } });
    routes['GET /api/providers/1001/ahc/slots'] = () => ({
      json: {
        booking_slots: [
          { date: '2030-01-15', slots: [slot('2030-01-15T02:30:00.000Z', false), slot('2030-01-15T03:30:00.000Z')] },
          { date: '2030-01-16', slots: [slot('2030-01-16T02:30:00.000Z')] },
        ],
      },
    });
    routes['POST /api/appointments'] = () => ({
      json: {
        provider_id: 1001,
        booking_id: 'EKI0000000001700000000',
        status: 'confirmed',
        customers: [{ api_customer_id: 'CUST1001', appointment_id: 'APT1A2B3C4D5' }],
      },
    });
    routes['GET /api/appointments'] = () => ({
      json: { booking_id: 'EKI0000000001700000000', appointments: [{ appointment_id: 'APT1A2B3C4D5', status: 'confirmed' }] },
    });
    routes['PATCH /api/appointments/APT1A2B3C4D5/reschedule'] = () => ({ json: { message: 'Appointment rescheduled successfully' } });
    routes['GET /api/appointments/APT1A2B3C4D5/voucher'] = () => ({ buffer: Buffer.from('%PDF-1.4 voucher') });
    routes['PATCH /api/appointments/APT1A2B3C4D5/cancel'] = () => ({ json: { message: 'Appointment cancelled successfully' } });
    voucherFile = join(process.cwd(), 'voucher-APT1A2B3C4D5.pdf');

    await runExample('book-health-checkup');

    expect(tokenCalls()).toHaveLength(1);
    const sent = apiCalls();
    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/providers',
      'GET /api/providers/1001/ahc/slots',
      'POST /api/appointments',
      'GET /api/appointments',
      'PATCH /api/appointments/APT1A2B3C4D5/reschedule',
      'GET /api/appointments/APT1A2B3C4D5/voucher',
      'PATCH /api/appointments/APT1A2B3C4D5/cancel',
    ]);
    for (const call of sent) expect(call.headers.authorization).toBe('Bearer token-1');

    const [providers, slots, create, get, reschedule, , cancel] = sent;
    expect(providers.query).toEqual({ service_name: 'ahc', package_ids: '1001', pincode: '500081' });
    expect(slots.query).toEqual({ package_ids: '1001', pincode: '500081' });
    expect(create.headers['content-type']).toBe('application/json');
    expect(create.json).toEqual({
      provider_id: 1001,
      appointment_date_time: '2030-01-15T03:30:00.000Z',
      appointment_type: 'home_collection',
      service_name: 'ahc',
      customers: [
        {
          name: 'Jane Doe',
          dob: '1990-08-24',
          mobile_number: '9999999999',
          api_customer_id: 'CUST1001',
          gender: 'female',
          package_ids: [1001],
          booking_customer: true,
        },
      ],
      address: {
        address_line_one: '1 Example Road',
        address_line_two: 'Madhapur',
        city: 'Hyderabad',
        state: 'Telangana',
        country: 'India',
        pincode: '500081',
        latitude: 17.4437,
        longitude: 78.386,
      },
    });
    expect(get.query).toEqual({ booking_id: 'EKI0000000001700000000', appointment_id: 'APT1A2B3C4D5' });
    expect(reschedule.json).toEqual({ appointment_date_time: '2030-01-16T02:30:00.000Z' });
    expect(cancel.raw.length).toBe(0);
    expect(cancel.headers['content-type']).toBeUndefined();
    expect((await readFile(voucherFile)).toString()).toBe('%PDF-1.4 voucher');
  });
});

// ------------------------------------------------------------------ book-consultation.mjs

describe('book-consultation.mjs', () => {
  it('lists doctors and slots, then books an in-clinic consultation', async () => {
    routes['GET /api/consultations/inclinic_consultation/providers'] = () => ({ json: { providers: [{ provider_id: 2001 }] } });
    routes['GET /api/providers/2001/inclinic_consultation/slots'] = () => ({
      json: { booking_slots: [{ date: '2030-01-15', slots: [{ utc_slot_time: '2030-01-15T04:30:00.000Z', available: true }] }] },
    });
    routes['POST /api/consultations/inclinic_consultation'] = () => ({
      json: { provider_id: 2001, booking_id: 'EKI0000000001700000000', customers: [{ appointment_id: 'APT1A2B3C4D5', consultation_status: 'new' }] },
    });
    routes['GET /api/consultations/inclinic_consultation/APT1A2B3C4D5'] = () => ({ json: { appointment_id: 'APT1A2B3C4D5' } });

    await runExample('book-consultation');

    const [providers, slots, create, get] = apiCalls();
    expect(providers.query).toEqual({ package_ids: '2001', pincode: '500084' });
    expect(slots.query).toEqual({ package_ids: '2001' });
    expect(create.method).toBe('POST');
    expect(create.json).toEqual({
      appointment_date_time: '2030-01-15T04:30:00.000Z',
      service_mode: 'at_provider_location',
      provider_id: 2001,
      customers: [
        { name: 'Jane Doe', dob: '1990-08-24', mobile_number: '9999999999', api_customer_id: 'CUST1001', gender: 'female', package_ids: [2001] },
      ],
      address: {
        address_line_one: '1 Example Road',
        address_line_two: 'Kondapur',
        city: 'Hyderabad',
        state: 'Telangana',
        country: 'India',
        pincode: '500084',
        latitude: 17.47,
        longitude: 78.35,
      },
    });
    expect(get.path).toBe('/api/consultations/inclinic_consultation/APT1A2B3C4D5');
  });
});

// ------------------------------------------------------------------ pharmacy-order.mjs

describe('pharmacy-order.mjs', () => {
  it('searches, fills the cart, reads fulfillment options and places the order', async () => {
    routes['GET /api/epharmacy/medicines/search'] = () => ({
      json: { medicines: [{ id: 50001, available: true, rx_required: false }], meta: { page: 1 } },
    });
    routes['PATCH /api/epharmacy/cart'] = () => ({ json: { success: true, cart: { id: 701 } } });
    routes['GET /api/epharmacy/fulfillment_options'] = () => ({
      json: { success: true, delivery_options: { success: true, standard: { vendor_id: 3, location_token: 'OPAQUE_TOKEN' } }, pickup_options: { success: false } },
    });
    routes['POST /api/epharmacy/orders'] = () => ({
      json: { success: true, status: 'confirmed', booking_id: 90001, user_prescription_details: { status: 'confirmed', unique_id: 'EPO000000000001' } },
    });

    await runExample('pharmacy-order');

    const [search, cart, options, order] = apiCalls();
    expect(search.query).toEqual({ name: 'paracetamol' });
    expect(cart.method).toBe('PATCH');
    expect(cart.json).toEqual({
      customer_details: { api_customer_id: 'CUST1001', name: 'Jane Doe', mobile_number: '9999999999', gender: 'female', dob: '1990-08-24' },
      products: [{ id: 50001, quantity: 2 }],
      address: { line1: '1 Example Road', line2: 'Motera', city: 'Ahmedabad', state: 'Gujarat', pincode: '380005' },
    });
    expect(options.query).toEqual({ 'customer_details[api_customer_id]': 'CUST1001', cart_id: '701' });
    expect(order.json).toEqual({
      customer_details: { api_customer_id: 'CUST1001' },
      cart_id: 701,
      delivery_option: 'standard',
      medicine_vendor_id: 3,
      location_token: 'OPAQUE_TOKEN',
    });
  });
});

// ------------------------------------------------------------------ upload-prescription.mjs

describe('upload-prescription.mjs', () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('uploads the prescription as multipart with an Idempotency-Key, then polls the status', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hlthstack-'));
    const file = join(dir, 'rx.pdf');
    await writeFile(file, '%PDF-1.4 prescription');
    process.env.PRESCRIPTION_FILE = file;
    let polls = 0;
    routes['POST /api/prescriptions/digitize'] = () => ({ status: 202, json: { request_id: 'DIGI_RQ_A1B2C3D4E', status: 'pending' } });
    routes['GET /api/prescriptions/digitize/DIGI_RQ_A1B2C3D4E'] = () => ({
      json: { request_id: 'DIGI_RQ_A1B2C3D4E', status: ++polls === 1 ? 'completed' : 'failed', items: [], cart_id: 701 },
    });

    await runExample('upload-prescription');

    const [upload, status] = apiCalls();
    expect(upload.method).toBe('POST');
    expect(upload.headers.authorization).toBe('Bearer token-1');
    expect(upload.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const fields = [...upload.form.keys()];
    expect(fields).toEqual([
      'customers[][name]',
      'customers[][api_customer_id]',
      'customers[][mobile_number]',
      'customers[][gender]',
      'customers[][dob]',
      'files[]',
    ]);
    expect(upload.form.get('customers[][api_customer_id]')).toBe('CUST1001');
    expect(upload.form.get('customers[][mobile_number]')).toBe('9999999999');
    expect(upload.form.get('customers[][gender]')).toBe('female');
    expect(upload.form.get('customers[][dob]')).toBe('1990-08-24');
    const uploaded = upload.form.get('files[]');
    expect(uploaded.name).toBe('rx.pdf');
    expect(uploaded.type).toBe('application/pdf');
    expect(await uploaded.text()).toBe('%PDF-1.4 prescription');
    expect(status.path).toBe('/api/prescriptions/digitize/DIGI_RQ_A1B2C3D4E');
    expect(polls).toBe(1);
  });
});

// ------------------------------------------------------------------ pre-registration.mjs

describe('pre-registration.mjs', () => {
  it('uses its own token, sent raw as X-EKINCARE-KEY, and polls until completed', async () => {
    routes['POST /v1/corporate/pre_registrations'] = () => ({
      json: { message: 'Request has been accepted', request_id: '3f2b8c1e-0d4a-4c5e-9b7a-2e6f1d8c9a01' },
    });
    routes['GET /v1/corporate/pre_registrations/3f2b8c1e-0d4a-4c5e-9b7a-2e6f1d8c9a01/status'] = () => ({
      json: { request_id: '3f2b8c1e-0d4a-4c5e-9b7a-2e6f1d8c9a01', status: 'completed', success_records: [{}, {}], failure_records: [] },
    });

    await runExample('pre-registration');

    expect(tokenCalls()).toHaveLength(0); // the booking API token is never requested
    const [token] = tokenCalls('/api/pre_registration/access-token');
    expect(tokenCalls('/api/pre_registration/access-token')).toHaveLength(1); // cached across calls
    expect(token.headers.authorization).toBe(basic(PREREG_USERNAME, PREREG_PASSWORD));

    const [create, status] = apiCalls();
    for (const call of [create, status]) {
      expect(call.headers['x-ekincare-key']).toBe('prereg-token-1');
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers['api-entity-id']).toBeUndefined();
    }
    expect(create.method).toBe('POST');
    expect(create.path).toBe('/v1/corporate/pre_registrations');
    const [employee] = create.json.employees;
    expect(Object.keys(employee).sort()).toEqual(
      [
        'company_id', 'employee_code', 'first_name', 'last_name', 'email', 'date_of_birth', 'gender',
        'mobile_number', 'vip', 'entity_name', 'employee_office_location', 'department', 'grade', 'date_of_joining',
      ].sort(),
    );
    expect(create.json.dependants[0]).toMatchObject({ guardian_email: 'jane.doe@example.com', relation: 'Father', date_of_birth: '10-02-1960' });
    expect(status.method).toBe('GET');
  });

  it('refreshes the pre-registration token on an empty 401', async () => {
    let first = true;
    routes['GET /v1/corporate/pre_registrations/abc/status'] = () => {
      if (first) {
        first = false;
        return { status: 401 };
      }
      return { json: { status: 'completed' } };
    };
    const { preRegistrationApi } = await loadClient();
    expect(await preRegistrationApi('GET', '/v1/corporate/pre_registrations/abc/status')).toEqual({ status: 'completed' });
    expect(apiCalls().map((c) => c.headers['x-ekincare-key'])).toEqual(['prereg-token-1', 'prereg-token-2']);
  });
});

// ------------------------------------------------------------------ webhook-verify.mjs

describe('webhook-verify.mjs', () => {
  const SECRET = 'example-webhook-secret';
  const NOW = 1_768_440_000;
  const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = (claims, { secret = SECRET, alg = 'HS256' } = {}) => {
    const head = `${b64url({ alg, typ: 'JWT' })}.${b64url(claims)}`;
    return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
  };

  const appointment = { type: 'status_update', booking_id: 'EKI0000000001700000000', appointment_id: 'APT1A2B3C4D5' };
  const appointmentClaims = { appointment_id: 'APT1A2B3C4D5', booking_id: 'EKI0000000001700000000', timestamp: NOW, webhook_type: 'status_update' };
  const order = { type: 'post_billing', order_id: 'EPO000000000003', service_type: 'pharmacy' };
  const orderClaims = { order_id: 'EPO000000000003', timestamp: NOW, webhook_type: 'post_billing' };
  const digitization = { type: 'digitization_results', request_id: 'DIGI_RQ_A1B2C3D4E' };
  const digitizationClaims = { request_id: 'DIGI_RQ_A1B2C3D4E', timestamp: NOW, webhook_type: 'digitization_results' };

  it('accepts correctly signed appointment, pharmacy and digitization webhooks', async () => {
    const { verifyWebhook } = await import('../examples/api/webhook-verify.mjs');
    expect(verifyWebhook(sign(appointmentClaims), appointment, SECRET, { now: NOW + 10 })).toEqual(appointmentClaims);
    expect(verifyWebhook(sign(orderClaims), order, SECRET, { now: NOW - 10 })).toEqual(orderClaims);
    expect(verifyWebhook(sign(digitizationClaims), digitization, SECRET, { now: NOW + 299 })).toEqual(digitizationClaims);
  });

  it('uses the current time by default', async () => {
    const { verifyWebhook } = await import('../examples/api/webhook-verify.mjs');
    const claims = { ...appointmentClaims, timestamp: Math.floor(Date.now() / 1000) };
    expect(verifyWebhook(sign(claims), appointment, SECRET)).toEqual(claims);
  });

  it('rejects tampered, stale, mismatched and malformed signatures', async () => {
    const { verifyWebhook, WebhookError } = await import('../examples/api/webhook-verify.mjs');
    const rejects = (signature, body, options = { now: NOW }) =>
      expect(() => verifyWebhook(signature, body, SECRET, options)).toThrow(WebhookError);

    // Signature
    rejects(sign(appointmentClaims, { secret: 'other-secret' }), appointment);
    const [h, , s] = sign(appointmentClaims).split('.');
    rejects(`${h}.${b64url({ ...appointmentClaims, appointment_id: 'APT9Z9Z9Z9Z9' })}.${s}`, { ...appointment, appointment_id: 'APT9Z9Z9Z9Z9' });
    rejects(`${sign(appointmentClaims).slice(0, -2)}xx`, appointment);
    rejects(sign(appointmentClaims, { alg: 'none' }), appointment);
    rejects(`${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(appointmentClaims)}.`, appointment);
    rejects(undefined, appointment);
    rejects('not-a-jwt', appointment);
    rejects('a.b.c', appointment);

    // Timestamp
    rejects(sign(appointmentClaims), appointment, { now: NOW + 301 });
    rejects(sign(appointmentClaims), appointment, { now: NOW - 301 });
    rejects(sign(appointmentClaims), appointment, { now: NOW + 61, toleranceSeconds: 60 });
    rejects(sign({ ...appointmentClaims, timestamp: String(NOW) }), appointment);
    rejects(sign({ ...appointmentClaims, timestamp: undefined }), appointment);

    // Ids
    rejects(sign(appointmentClaims), { ...appointment, appointment_id: 'APT9Z9Z9Z9Z9' });
    rejects(sign(appointmentClaims), { ...appointment, booking_id: 'EKI9999999999999999999' });
    rejects(sign({ ...appointmentClaims, appointment_id: undefined, booking_id: undefined }), {});
    rejects(sign(orderClaims), { ...order, order_id: 'EPO000000000004' });
    rejects(sign(orderClaims), { ...order, type: 'status_update' });
    rejects(sign(digitizationClaims), { ...digitization, request_id: 'DIGI_RQ_OTHER' });
  });
});
