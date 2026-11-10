# Plain REST API integration guide (JavaScript)

Call the hlthstack REST API directly from Node.js 18+ with the built-in `fetch`: no SDK and no
runtime dependency (the webhook receiver uses Express). You handle token refresh, input
validation and error parsing yourself; this guide shows small helpers for each.

Every snippet here comes from the runnable scripts in [`examples/api/`](../examples/api/),
which are tested against a mock server in
[`test/api-examples.test.mjs`](../test/api-examples.test.mjs). The full reference is the
[OpenAPI spec](https://github.com/hlthstack/integration-guide/blob/main/openapi/openapi.yaml)
and the [integration guide](https://github.com/hlthstack/integration-guide/tree/main/docs).

> **Server-side only.** Your API credentials, access tokens, entity secret key and webhook
> secret must never be shipped to a browser or mobile app. Call hlthstack from your backend.

Contents:

1. [Environments and base URLs](#environments-and-base-urls)
2. [Authentication](#authentication)
3. [Multi-entity partners](#multi-entity-partners)
4. [Book a health checkup end to end](#book-a-health-checkup-end-to-end)
5. [Consultations and ePharmacy](#consultations-and-epharmacy)
6. [File uploads](#file-uploads)
7. [Pre-registration](#pre-registration)
8. [Errors](#errors)
9. [Validating inputs yourself](#validating-inputs-yourself)
10. [Webhooks](#webhooks)
11. [Moving to the SDK](#moving-to-the-sdk)

## Environments and base URLs

| Environment | Base URL |
|---|---|
| Production | `https://api.hlthstack.io` |
| Staging | `https://staging-api.hlthstack.io` |

Credentials, package ids, plan ids, entity ids and webhook secrets are different per
environment. Staging also has endpoints that move bookings through their lifecycle and fire
real webhooks ([testing guide](https://github.com/hlthstack/integration-guide/blob/main/docs/testing.md)).
Use a client timeout of 30-60 seconds.

The examples read their configuration from environment variables and default to staging:

```sh
export HLTHSTACK_BASE_URL=https://staging-api.hlthstack.io   # optional
export HLTHSTACK_USERNAME=example-user
export HLTHSTACK_PASSWORD=example-password
node examples/api/book-health-checkup.mjs
```

```js
export const BASE_URL = process.env.HLTHSTACK_BASE_URL ?? 'https://staging-api.hlthstack.io';
```

## Authentication

1. `GET /api/get-access-token` with HTTP Basic auth (the username and password hlthstack
   issued to you) returns `{ "access_token": "...", "expires_at": "2026-01-15T07:16:21Z" }`.
   Wrong credentials return `401 {"message": "Wrong credentials"}`.
2. Send the token on every other call as `Authorization: Bearer <access_token>`.
3. Tokens last **1 hour** and there is no refresh token: request a new one before
   `expires_at`. A missing, invalid or expired token returns `401` with the plain-text body
   `HTTP Token: Access denied.`

`getToken()` caches the token until 5 minutes before it expires and makes concurrent callers
share one token request. The same factory serves the pre-registration token
([below](#pre-registration)), whose `expires_at` has a different format.

```js
const REFRESH_EARLY_MS = 5 * 60 * 1000; // renew 5 minutes before expires_at
const TOKEN_LIFETIME_MS = 60 * 60 * 1000; // tokens last 1 hour

/** `expires_at` is ISO 8601, or `2026-01-15 07:16:21 UTC` for pre-registration tokens. */
function parseExpiry(expiresAt) {
  const ms = Date.parse(String(expiresAt).replace(/^(\S+) (\S+) UTC$/, '$1T$2Z'));
  return Number.isNaN(ms) ? Date.now() + TOKEN_LIFETIME_MS : ms;
}

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

export const getToken = tokenCache(
  '/api/get-access-token',
  process.env.HLTHSTACK_USERNAME,
  process.env.HLTHSTACK_PASSWORD,
);
```

`api(method, path, options)` adds the bearer token (and the [entity headers](#multi-entity-partners)),
sends JSON bodies, fetches a new token and retries **once** on `401`, and throws an
[`ApiError`](#errors) with the parsed body on any other non-2xx response. Options:
`query` (object), `body` (JSON), `form` (`FormData`), `headers`, and `binary: true` to get a
`Buffer` back.

```js
async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // e.g. 'HTTP Token: Access denied.'
  }
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

export function api(method, path, options = {}) {
  return request(method, path, options, async (forceRefresh) => ({
    Authorization: `Bearer ${await getToken({ forceRefresh })}`,
    ...entityHeaders(),
  }));
}
```

The full file is [`examples/api/client.mjs`](../examples/api/client.mjs).

## Multi-entity partners

If your company has several entities, your credentials are issued for the first one. To act
for another entity, send two headers on every call **except** `get-access-token`:

| Header | Value |
|---|---|
| `API-ENTITY-ID` | The id of the entity to act for (shared at onboarding) |
| `API-SECRET-KEY` | The secret key shared at onboarding. Required whenever `API-ENTITY-ID` is sent |

Without `API-ENTITY-ID`, calls act for the entity tied to the credentials. These headers are
not used by [pre-registration](#pre-registration).

```js
/** Multi-entity partners: sent on every call except the token endpoints. */
function entityHeaders() {
  const entityId = process.env.HLTHSTACK_ENTITY_ID;
  if (!entityId) return {};
  return { 'API-ENTITY-ID': entityId, 'API-SECRET-KEY': process.env.HLTHSTACK_SECRET_KEY ?? '' };
}

// Act for another entity on one call:
await api('POST', '/api/appointments', { body, headers: { 'API-ENTITY-ID': 'ENTITY_B_ID' } });
```

Header problems return `400 {"message": "..."}`: `API-ENTITY-ID header cannot be blank`,
`API-SECRET-KEY header cannot be blank`, `Invalid Entity`,
`API integration not enabled for this entity`, `API-SECRET-KEY is invalid`. See
[authentication.md](https://github.com/hlthstack/integration-guide/blob/main/docs/authentication.md#multi-entity-partners).

## Book a health checkup end to end

The whole flow is [`examples/api/book-health-checkup.mjs`](../examples/api/book-health-checkup.mjs).
Package ids are shared at onboarding; `service_name` is `ahc` for health checks (also
`dental`, `vision`, `flu_vaccination`, `covid_vaccination`). Full details:
[health-checkups.md](https://github.com/hlthstack/integration-guide/blob/main/docs/health-checkups.md).

### 1. List providers

`GET /api/providers` with `service_name`, `package_ids` (comma-separated) and `pincode` (or
`latitude` + `longitude`). Optional: `radius`, `page`, `per_page` (max 50), `plan_id`,
`auto_allocate_provider`. Results are sorted by distance.

```js
import { api } from './client.mjs';

const PACKAGE_IDS = '1001';
const PINCODE = '500081';

const { providers } = await api('GET', '/api/providers', {
  query: { service_name: 'ahc', package_ids: PACKAGE_IDS, pincode: PINCODE },
});
const provider = providers.find((p) => p.home_collection_enabled) ?? providers[0];
```

### 2. Get slots

`GET /api/providers/{provider_id}/{benefit_type}/slots` with `package_ids` and `pincode`.
Pass `booking_date` (`YYYY-MM-DD`) for one day, or omit it for up to `count_days` (default 14).
Read `booking_slots[].slots[]` (the top-level `slots` is deprecated) and book with a slot's
`utc_slot_time`.

```js
const slots = await api('GET', `/api/providers/${provider.provider_id}/ahc/slots`, {
  query: { package_ids: PACKAGE_IDS, pincode: PINCODE },
});
const available = (slots.booking_slots ?? []).flatMap((day) => day.slots ?? []).filter((s) => s.available);
```

### 3. Create the booking

`POST /api/appointments`. `address` is required for `home_collection`. One appointment is
created per customer; they share a `booking_id`.

```js
const booking = await api('POST', '/api/appointments', {
  body: {
    provider_id: provider.provider_id,
    appointment_date_time: available[0].utc_slot_time,
    appointment_type: 'home_collection', // or 'inclinic'
    service_name: 'ahc',
    customers: [
      {
        name: 'Jane Doe',
        dob: '1990-08-24',
        mobile_number: '9999999999',
        api_customer_id: 'CUST1001',
        gender: 'female',
        package_ids: [Number(PACKAGE_IDS)],
        booking_customer: true,
      },
    ],
    address: {
      address_line_one: '1 Example Road',
      address_line_two: 'Madhapur',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
      pincode: PINCODE,
      latitude: 17.4437,
      longitude: 78.386,
    },
  },
});
if (booking.status === 'payment_pending') console.log('Send this link to the member:', booking.payment_link);
const appointmentId = booking.customers[0].appointment_id;
```

`status: "confirmed"` means the wallet paid; the appointment itself starts at `new` until the
provider confirms it (you get a webhook). Optional fields: `plan_id`, `customer_plan_id` /
`subscription_id`, `api_partner_order_id`. To get a price first, call
`POST /api/appointments/payment_details`.

### 4. Get the booking

`GET /api/appointments?booking_id=...` returns every appointment in the booking; add
`appointment_id` for one.

```js
const details = await api('GET', '/api/appointments', {
  query: { booking_id: booking.booking_id, appointment_id: appointmentId },
});
const appointment = details.appointments[0];
console.log('Status:', appointment.status);
```

### 5. Reschedule

`PATCH /api/appointments/{appointment_id}/reschedule` (or `/api/bookings/{booking_id}/reschedule`
for every appointment in the booking). Body: `appointment_date_time`, plus `provider_id` to move
to another provider and, for home collection, `address` together with `provider_id`.

```js
await api('PATCH', `/api/appointments/${appointmentId}/reschedule`, {
  body: { appointment_date_time: available[1].utc_slot_time },
});
```

Allowed until 30 minutes before the slot (home collection: or until a phlebotomist is
assigned, whichever is first). Booking-level calls can partly succeed: the 200 body then
carries comma-separated `success` and `failed` appointment ids.

### 6. Cancel

`PATCH /api/appointments/{appointment_id}/cancel` (or `/api/bookings/{booking_id}/cancel`).
No body; same cut-offs as reschedule.

```js
await api('PATCH', `/api/appointments/${appointmentId}/cancel`);
```

### 7. Download the voucher

`GET /api/appointments/{appointment_id}/voucher` returns a PDF once the appointment is
`confirmed` (before that: `400 voucher only available for download when appointment is confirmed`).
Ask for the raw bytes:

```js
import { writeFile } from 'node:fs/promises';

if (appointment.status === 'confirmed') {
  const pdf = await api('GET', `/api/appointments/${appointmentId}/voucher`, { binary: true });
  await writeFile(`voucher-${appointmentId}.pdf`, pdf);
}
```

After the visit, `GET /api/appointments/{appointment_id}/reports` and `.../lab_results` return
the reports and digitized values.

## Consultations and ePharmacy

### In-clinic consultation

List doctors with `GET /api/consultations/inclinic_consultation/providers` (`package_ids`,
`pincode`), get slots with `GET /api/providers/{provider_id}/inclinic_consultation/slots`, then
book. `address` (including `pincode`) is required and `appointment_date_time` must be in the
future. Script: [`examples/api/book-consultation.mjs`](../examples/api/book-consultation.mjs).

```js
const consultation = await api('POST', '/api/consultations/inclinic_consultation', {
  body: {
    appointment_date_time: slot.utc_slot_time,
    service_mode: 'at_provider_location',
    provider_id: doctor.provider_id,
    customers: [
      { name: 'Jane Doe', dob: '1990-08-24', mobile_number: '9999999999', api_customer_id: 'CUST1001', gender: 'female', package_ids: [2001] },
    ],
    address: {
      address_line_one: '1 Example Road', address_line_two: 'Kondapur', city: 'Hyderabad',
      state: 'Telangana', country: 'India', pincode: '500084', latitude: 17.47, longitude: 78.35,
    },
  },
});
const appointmentId = consultation.customers[0].appointment_id;
const details = await api('GET', `/api/consultations/inclinic_consultation/${appointmentId}`);
```

Online specialist consultations (scheduled and priority), reschedule, cancel and
prescriptions: [consultations.md](https://github.com/hlthstack/integration-guide/blob/main/docs/consultations.md).

### ePharmacy: cart to order

Search medicines, fill the member's cart, read the fulfillment options, then order with the
chosen option's `vendor_id` and `location_token`. Script:
[`examples/api/pharmacy-order.mjs`](../examples/api/pharmacy-order.mjs).

```js
const member = { api_customer_id: 'CUST1001' };

const { medicines } = await api('GET', '/api/epharmacy/medicines/search', { query: { name: 'paracetamol' } });
const medicine = medicines.find((m) => m.available && !m.rx_required);

const { cart } = await api('PATCH', '/api/epharmacy/cart', {
  body: {
    customer_details: { ...member, name: 'Jane Doe', mobile_number: '9999999999', gender: 'female', dob: '1990-08-24' },
    products: [{ id: medicine.id, quantity: 2 }],
    address: { line1: '1 Example Road', line2: 'Motera', city: 'Ahmedabad', state: 'Gujarat', pincode: '380005' },
  },
});

// Slow (3-8 s). HTTP 200 can still carry success: false inside delivery_options / pickup_options.
const options = await api('GET', '/api/epharmacy/fulfillment_options', {
  query: { 'customer_details[api_customer_id]': member.api_customer_id, cart_id: cart.id },
});
const standard = options.delivery_options?.success ? options.delivery_options.standard : undefined;

const order = await api('POST', '/api/epharmacy/orders', {
  body: {
    customer_details: member,
    cart_id: cart.id,
    delivery_option: 'standard',
    medicine_vendor_id: standard.vendor_id,
    location_token: standard.location_token,
  },
});
// order.status: confirmed | payment_pending (payment_link) | partner_payment_pending (amount_to_collect)
```

Notes: on GET endpoints the member goes in the query as `customer_details[api_customer_id]`.
`POST /api/epharmacy/orders/payment_details` prices the cart first (its field is
`selected_delivery_option`, not `delivery_option`). Prescriptions, store pickup,
partner-collected payments and cancellation:
[epharmacy.md](https://github.com/hlthstack/integration-guide/blob/main/docs/epharmacy.md).

## File uploads

Send `multipart/form-data` with the built-in `FormData` and `Blob`, and let `fetch` set the
`Content-Type` boundary (don't set it yourself). Prescription digitization
(`POST /api/prescriptions/digitize`) takes exactly one customer as bracketed fields plus
`files[]` (JPEG, PNG or PDF, each up to 10 MB), and an optional `plan_id`. An
`Idempotency-Key` header makes retries safe. Script:
[`examples/api/upload-prescription.mjs`](../examples/api/upload-prescription.mjs).

```js
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const form = new FormData();
form.append('customers[][name]', 'Jane Doe');
form.append('customers[][api_customer_id]', 'CUST1001');
form.append('customers[][mobile_number]', '9999999999');
form.append('customers[][gender]', 'female');
form.append('customers[][dob]', '1990-08-24');
form.append('files[]', new Blob([await readFile('rx.pdf')], { type: 'application/pdf' }), 'rx.pdf');

const accepted = await api('POST', '/api/prescriptions/digitize', {
  form,
  headers: { 'Idempotency-Key': randomUUID() },
});
// 202 { request_id, status: 'pending' }. Poll GET /api/prescriptions/digitize/{request_id}
// or wait for the digitization_results webhook.
```

Other multipart endpoints: `PATCH /api/epharmacy/cart` with `customer_details[api_customer_id]`
and `prescription_files[]` (each under 7 MB), and
`POST /api/consultations/{appointment_id}/upload_documents` with one `files[][name]` (a
title) and `files[][value]` (the file) pair per document.

## Pre-registration

Bulk member registration has **its own credentials** (an account email and password) and its
own token, and the token goes in the `X-EKINCARE-KEY` header **without** a `Bearer` prefix.
The booking API token does not work here and vice versa, and the entity headers are not used
(each row names its `company_id`).

1. `GET /api/pre_registration/access-token` with HTTP Basic (the account email as username)
   returns `{ "access_token": "...", "expires_at": "2026-01-15 07:16:21 UTC" }`. Note the
   `expires_at` format: UTC, but not ISO 8601. Valid for 1 hour.
2. Send `X-EKINCARE-KEY: <access_token>` on the `/v1/corporate/pre_registrations` calls.
3. A missing, invalid or expired token returns `401` with an **empty body** (also once your
   contract has ended); `403` with an empty body means the account's role may not use the API.

```js
export const getPreRegistrationToken = tokenCache(
  '/api/pre_registration/access-token',
  process.env.HLTHSTACK_PREREG_USERNAME,
  process.env.HLTHSTACK_PREREG_PASSWORD,
);

export function preRegistrationApi(method, path, options = {}) {
  return request(method, path, options, async (forceRefresh) => ({
    'X-EKINCARE-KEY': await getPreRegistrationToken({ forceRefresh }),
  }));
}
```

Writes are asynchronous: each returns a `request_id`; poll the status until `completed`.
Script: [`examples/api/pre-registration.mjs`](../examples/api/pre-registration.mjs).

```js
const { request_id } = await preRegistrationApi('POST', '/v1/corporate/pre_registrations', {
  body: {
    employees: [
      {
        employee_code: 'EMP1001', company_id: '1001', first_name: 'Jane', last_name: 'Doe',
        email: 'jane.doe@example.com', date_of_birth: '24-08-1990', gender: 'Female',
        mobile_number: '9999999999', vip: 'No', entity_name: '', employee_office_location: 'Hyderabad',
        department: 'Engineering', grade: 'B', date_of_joining: '01-01-2026',
      },
    ],
    dependants: [
      {
        guardian_email: 'jane.doe@example.com', dependent_code: 'DEP-001', first_name: 'John',
        last_name: 'Doe', date_of_birth: '10-02-1960', gender: 'Male', mobile_number: '9999999998',
        relation: 'Father',
      },
    ],
  },
});

let result = await preRegistrationApi('GET', `/v1/corporate/pre_registrations/${request_id}/status`);
while (result.status !== 'completed') {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  result = await preRegistrationApi('GET', `/v1/corporate/pre_registrations/${request_id}/status`);
}
```

**Every required key must be present in every `create` row, even when empty** (`""` or
`null`): a row missing one is dropped silently and never appears in the status. At most 250
rows (employees plus dependants) per call. Updates go to `POST .../pre_registrations/update`
(identifier plus changed fields only) and deactivations to `POST .../pre_registrations/deactivate`
(employee emails, dependant mobile numbers). See
[pre-registration.md](https://github.com/hlthstack/integration-guide/blob/main/docs/pre-registration.md).

## Errors

Check the HTTP status first, then read the body defensively: the API uses several shapes.

| Shape | Example |
|---|---|
| Field errors | `{"errors": {"package_ids": ["should be an integer array"]}}` (nested fields are prefixed: `customer_mobile_number`, `address_pincode`) |
| Messages | `{"errors": {"messages": ["This booking cannot be rescheduled"]}}` |
| Plain message | `{"message": "Required details are missing"}` |
| Bare list | `{"errors": ["Invalid status"]}` (staging simulators) |
| Success flag | `{"success": false, "message": "Order not found"}` (ePharmacy) |
| Booking failure | `{"msg": "...", "recall": false}` |
| Single error | `{"error": "Invalid company slug for authenticated partner."}` (wallet) |
| Plain text / empty | `HTTP Token: Access denied.` (401); pre-registration 401/403 have no body |

`ApiError` keeps the original body and flattens all of these into `messages`:

```js
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

try {
  await api('PATCH', `/api/appointments/${appointmentId}/reschedule`, {
    body: { appointment_date_time: '2030-01-16T02:30:00Z' },
  });
} catch (error) {
  if (!(error instanceof ApiError)) throw error; // network failure or timeout
  console.log(error.status, error.messages, error.requestId);
}
```

Some ePharmacy responses are HTTP 200 with a nested `success: false` (for example
`delivery_options` in fulfillment options): check those flags too.

**Retrying.** `api()` retries only once after a `401`. Retry `5xx`, `409` and network errors
(including timeouts) with backoff yourself. `400`, `403` and `404` mean the request needs
fixing, as do most `422`s, except those that ask you to wait (`Previous request is in progress,
please try ... after few minutes`) and the pre-registration `422 something went wrong`.
**Don't blindly retry booking creation** (`POST /api/appointments` or consultation
creation): a timeout doesn't mean the booking failed, so check with
`GET /api/appointments?booking_id=...`, the member's appointments, or your webhooks first.
Prescription digitization (with an `Idempotency-Key`) and partner-payment confirmation are
safe to retry. See [errors.md](https://github.com/hlthstack/integration-guide/blob/main/docs/errors.md).

## Validating inputs yourself

The server rejects invalid input with `400`/`422`. Checking the most common rules before you
call saves a round trip and gives your users clearer messages:

| Field | Rule |
|---|---|
| `pincode` | 6 digits (`^[0-9]{6}$` in queries). In a booking `address`, it cannot start with 0 |
| Location | `listProviders`: `pincode`, or both `latitude` and `longitude` |
| `api_customer_id` | Alphanumeric only (`^[a-zA-Z0-9]+$`), unique within a request's `customers` |
| `mobile_number` | Exactly 10 digits, no `+91` or spaces (`^[0-9]{10}$`) |
| `gender` | Bookings and consultations: `male`, `female` or `non-binary` (lowercase). Pre-registration: `Male`, `Female` or `Non-binary` (dependants: `Male` or `Female`) |
| `dob` | `YYYY-MM-DD`, and members must be at least 1 year old |
| `package_ids` | Query: comma-separated ids (`1001,1002`). Body: an array (`[1001]`) |
| `appointment_date_time` | ISO 8601 UTC, use a slot's `utc_slot_time`. Consultations: must be in the future (a time without an offset is read as IST) |
| Home collection | `address` is required, with `address_line_one`, `address_line_two` (each up to 254 characters), `city`, `state`, `country`, `latitude`, `longitude` (non-negative); the text fields must not contain any other 6-digit pincode |
| In-clinic consultation | `address` is required, including `pincode` |
| Pre-registration | At most 250 rows per call; every required key present in each `create` row; dates `DD-MM-YYYY` or `DD/MM/YYYY`; `vip` `Yes`/`No` |
| ePharmacy cart | At least one change; `address` or `address_id`, not both; unique product ids; `selected_chemist_id` for store pickup |

The complete list is in the [OpenAPI spec](https://github.com/hlthstack/integration-guide/blob/main/openapi/openapi.yaml):
each request schema's `required`, `enum`, `pattern`, length and range keywords, and the
cross-field and date rules under each operation's `x-hlthstack-rules` (kinds listed in
`x-hlthstack-rule-kinds`). Checks that need stored data (plan benefits, package ids, slot
availability) are only made by the server. The [SDK](sdk-integration.md#validation) runs all
of these checks automatically before every call.

## Webhooks

hlthstack POSTs JSON to the URLs you register, with an HS256 JWT in the `Signature` header,
signed with your webhook secret. The JWT has no `exp` and does **not** cover the body, so
verify all three:

1. The signature is valid for your secret (HS256 only).
2. The `timestamp` claim (Unix seconds) is within your tolerance window (5 minutes).
3. The ids in the claims match the body: `order_id` and `webhook_type` = body `type` for
   pharmacy; `request_id` for prescription digitization; otherwise `appointment_id` and
   `booking_id`.

No JWT library is needed; `node:crypto` is enough
([`examples/api/webhook-verify.mjs`](../examples/api/webhook-verify.mjs)):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export class WebhookError extends Error {}

const decodeJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export function verifyWebhook(signature, body, secret, { toleranceSeconds = 300, now = Date.now() / 1000 } = {}) {
  const parts = String(signature ?? '').split('.');
  if (parts.length !== 3) throw new WebhookError('missing or malformed Signature');
  const [header, payload, sig] = parts;

  // 1. HS256 only, and a valid signature for your secret.
  let alg, claims;
  try {
    ({ alg } = decodeJson(header));
    claims = decodeJson(payload);
  } catch {
    throw new WebhookError('malformed Signature');
  }
  if (alg !== 'HS256') throw new WebhookError('unexpected algorithm');
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new WebhookError('invalid signature');
  }

  // 2. A recent timestamp (Unix seconds), to block replays.
  if (typeof claims.timestamp !== 'number' || Math.abs(now - claims.timestamp) > toleranceSeconds) {
    throw new WebhookError('stale or missing timestamp');
  }

  // 3. The ids in the claims match the body.
  let matches;
  if (claims.order_id !== undefined) {
    matches = claims.order_id === body.order_id && claims.webhook_type === body.type;
  } else if (claims.request_id !== undefined) {
    matches = claims.request_id === body.request_id;
  } else {
    matches = Boolean(claims.appointment_id) && claims.appointment_id === body.appointment_id &&
      claims.booking_id === body.booking_id;
  }
  if (!matches) throw new WebhookError('claims do not match the body');
  return claims;
}
```

The receiver ([`examples/api/webhook-receiver.mjs`](../examples/api/webhook-receiver.mjs),
`npm install express`) answers `401` to anything that fails verification, and acknowledges
valid events immediately before processing them:

```js
import express from 'express';
import { verifyWebhook } from './webhook-verify.mjs';

const SECRET = process.env.HLTHSTACK_WEBHOOK_SECRET; // different for staging and production
const app = express();
app.use(express.json());

app.post('/hlthstack/webhooks', (req, res) => {
  try {
    verifyWebhook(req.get('Signature'), req.body, SECRET);
  } catch {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // acknowledge fast (hlthstack times out after 30 s)...
  setImmediate(() => handle(req.body)); // ...and process asynchronously
});
```

Delivery: retried up to 5 times on timeouts, connection errors and `408`/`502`/`503`/`504`
only. Order isn't guaranteed and each body is a full snapshot, so apply the latest one (use
the `timestamp` claim) and reconcile with the GET endpoints. Appointment and pharmacy events
share the status-updates URL. Payloads and claims per event:
[webhooks.md](https://github.com/hlthstack/integration-guide/blob/main/docs/webhooks.md).

## Moving to the SDK

Everything above is what the [`hlthstack` SDK](sdk-integration.md) does for you:

| Plain API (this guide) | SDK |
|---|---|
| `getToken()` / `getPreRegistrationToken()` caches | Automatic, per client |
| `api('POST', '/api/appointments', { body })` | `client.appointments.create(body)` |
| `query: { 'customer_details[api_customer_id]': id }` | `{ customer_details: { api_customer_id: id } }` |
| `FormData` with bracketed field names | `client.pharmacy.digitizePrescription(params, { idempotencyKey })` |
| `binary: true` | `getVoucher()` returns an `ArrayBuffer` |
| `entityHeaders()` / per-call `headers` | `entityId` / `secretKey` options |
| Hand-written checks | Every spec rule checked before sending (`HlthstackValidationError`) |
| `ApiError` / `errorMessages()` | `HlthstackError` (`status`, `body`, `messages`, `requestId`) |
| `verifyWebhook()` | `verifyWebhookSignature()` with typed payloads |

Request and response bodies are the same JSON, so you can switch one call at a time:

```sh
npm install github:hlthstack/js
```
