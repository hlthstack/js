# SDK integration guide (JavaScript and TypeScript)

The `hlthstack` package is a client for the [hlthstack](https://www.hlthstack.io/) partner REST
API: health checkups and lab tests, in-clinic and online consultations, ePharmacy orders,
benefit wallets and member pre-registration.

- Written in TypeScript, shipped as ESM and CommonJS with type declarations.
- Zero runtime dependencies. Works on Node.js 18+ and any runtime with `fetch`.
- Access tokens are fetched, cached and refreshed for you.
- One method per API operation, typed from the [OpenAPI spec](https://github.com/hlthstack/integration-guide/blob/main/openapi/openapi.yaml).
- Every call's input is checked against the API's rules before it is sent, so invalid
  parameters fail fast with a clear error instead of a round trip.
- Webhook signature verification.

Prefer raw HTTP calls without a dependency? See the [plain REST API guide](api-integration.md).

> **Server-side only.** Your API credentials, access tokens, entity secret key and webhook
> secret must never be shipped to a browser or mobile app. Call hlthstack from your backend.

REST reference and guides: https://github.com/hlthstack/integration-guide

## Install

Install straight from GitHub:

```sh
npm install github:hlthstack/js
```

Pin a release tag or commit for reproducible installs:

```sh
npm install github:hlthstack/js#<tag-or-commit>
```

npm builds the package (`dist/`) during the install, so the first install takes a little
longer. Import it as `hlthstack` either way. Publishing to the npm registry
(`npm install hlthstack`) is planned; the GitHub install keeps working when it lands.

## Quickstart

```ts
import { Hlthstack } from 'hlthstack';

const client = new Hlthstack({
  username: process.env.HLTHSTACK_USERNAME!,
  password: process.env.HLTHSTACK_PASSWORD!,
  environment: 'staging',
});

// 1. Find providers. The access token is requested on the first call and reused.
const { providers } = await client.appointments.listProviders({
  service_name: 'ahc',
  package_ids: '1001',
  pincode: '500081',
});
const provider = providers[0]!;

// 2. Pick a slot.
const slots = await client.appointments.listSlots(provider.provider_id!, 'ahc', {
  package_ids: '1001',
  pincode: '500081',
});
const slot = slots.booking_slots?.flatMap((day) => day.slots ?? []).find((s) => s.available);

// 3. Book.
const booking = await client.appointments.create({
  provider_id: provider.provider_id!,
  appointment_date_time: slot!.utc_slot_time!,
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

if (booking.status === 'payment_pending') {
  // send booking.payment_link to the member
}

// 4. Read it back.
const details = await client.appointments.get({ booking_id: booking.booking_id });
console.log(details.appointments.map((a) => [a.appointment_id, a.status]));
```

The same code is in [`examples/sdk/quickstart.ts`](../examples/sdk/quickstart.ts).

## Configuration

```ts
new Hlthstack({
  username: 'example-user',        // issued by hlthstack; required unless you only use pre-registration
  password: 'example-password',
  preRegistrationUsername: undefined, // pre-registration login (an email), only for client.preRegistration
  preRegistrationPassword: undefined,
  environment: 'production',       // 'production' | 'staging'
  baseUrl: undefined,              // optional override, e.g. a proxy
  entityId: undefined,             // multi-entity partners: entity to act for
  secretKey: undefined,            // required with entityId
  fetch: undefined,                // custom fetch (defaults to the global fetch)
  timeoutMs: 60_000,               // per-request timeout
  validate: true,                  // check inputs before sending (see Validation)
});
```

### Environments

| `environment` | Base URL |
|---|---|
| `production` | `https://api.hlthstack.io` |
| `staging` | `https://staging-api.hlthstack.io` |

Credentials, package ids, plan ids, entity ids and webhook secrets are different per
environment.

### Authentication

You never call the token endpoint yourself. The client:

- requests a token (`GET /api/get-access-token`, HTTP Basic) on the first API call;
- caches it and requests a new one 5 minutes before `expires_at` (tokens last 1 hour);
- shares one token request between concurrent calls;
- on a `401`, fetches a new token and retries the call once.

`client.auth.getAccessToken({ forceRefresh })` is available if you need the token itself.

`client.preRegistration.*` uses separate credentials (`preRegistrationUsername` /
`preRegistrationPassword`) and its own token: the client requests it from
`GET /api/pre_registration/access-token`, sends it as `X-EKINCARE-KEY`, and caches, shares
and refreshes it the same way. `client.preRegistration.getAccessToken({ forceRefresh })`
returns it.

### Multi-entity partners

Set `entityId` and `secretKey` to send `API-ENTITY-ID` and `API-SECRET-KEY` on every call
(never on `get-access-token`). Without them, calls act for the entity tied to your
credentials. Override per call:

```ts
await client.appointments.create(params, { entityId: 'ENTITY_B_ID' });  // uses the client's secretKey
await client.appointments.create(params, { entityId: null });           // the credentials' own entity
```

### Per-request options

Every method takes an optional last argument:

```ts
{
  entityId?: string | null;
  secretKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  validate?: boolean;   // override the client's `validate` for this call
}
```

## API

Method names follow the spec's `operationId`s, grouped by area.

| Area | Method | Endpoint |
|---|---|---|
| auth | `getAccessToken` | `GET /api/get-access-token` |
| appointments | `listProviders` | `GET /api/providers` |
| | `listSlots(providerId, benefitType, params)` | `GET /api/providers/{provider_id}/{benefit_type}/slots` |
| | `create` (createAppointment) | `POST /api/appointments` |
| | `get` (getAppointment) | `GET /api/appointments` |
| | `rescheduleBooking(bookingId, params)` | `PATCH /api/bookings/{booking_id}/reschedule` |
| | `cancelBooking(bookingId)` | `PATCH /api/bookings/{booking_id}/cancel` |
| | `reschedule(appointmentId, params)` | `PATCH /api/appointments/{appointment_id}/reschedule` |
| | `cancel(appointmentId)` | `PATCH /api/appointments/{appointment_id}/cancel` |
| | `getVoucher(appointmentId)` → `ArrayBuffer` | `GET /api/appointments/{appointment_id}/voucher` |
| | `getReports(appointmentId)` | `GET /api/appointments/{appointment_id}/reports` |
| | `getLabResults(appointmentId)` | `GET /api/appointments/{appointment_id}/lab_results` |
| consultations | `listInclinicProviders` | `GET /api/consultations/inclinic_consultation/providers` |
| | `listSpecialistProviders` | `GET /api/consultations/specialist_consultation/providers` |
| | `listSlots(providerId, benefitType, params)` | same as `appointments.listSlots` |
| | `createInclinic` | `POST /api/consultations/inclinic_consultation` |
| | `createSpecialist` | `POST /api/consultations/specialist_consultation` |
| | `getInclinic(appointmentId)` | `GET /api/consultations/inclinic_consultation/{appointment_id}` |
| | `getSpecialist(appointmentId)` | `GET /api/consultations/specialist_consultation/{appointment_id}` |
| | `reschedule(appointmentId, params)` | `PATCH /api/consultations/{appointment_id}/reschedule` |
| | `cancel(appointmentId)` | `PATCH /api/consultations/{appointment_id}/cancel` |
| | `getSummaryAndPrescription(appointmentId)` | `GET /api/consultations/{appointment_id}/summary_and_prescription` |
| | `getVoucher(appointmentId)` → `ArrayBuffer` | `GET /api/consultations/{appointment_id}/voucher` |
| | `uploadDocuments(appointmentId, documents)` | `POST /api/consultations/{appointment_id}/upload_documents` (multipart) |
| pharmacy | `searchMedicines` | `GET /api/epharmacy/medicines/search` |
| | `digitizePrescription(params, { idempotencyKey })` | `POST /api/prescriptions/digitize` (multipart) |
| | `getPrescriptionDigitization(requestId)` | `GET /api/prescriptions/digitize/{request_id}` |
| | `getCart` | `GET /api/epharmacy/cart` |
| | `updateCart` | `PATCH /api/epharmacy/cart` (JSON, or multipart with `prescription_files`) |
| | `getFulfillmentOptions` | `GET /api/epharmacy/fulfillment_options` |
| | `getOrderPaymentDetails` | `POST /api/epharmacy/orders/payment_details` |
| | `createOrder` | `POST /api/epharmacy/orders` |
| | `listOrders` | `GET /api/epharmacy/orders` |
| | `getOrder(orderId, params)` | `GET /api/epharmacy/orders/{order_id}` |
| | `cancelOrder(orderId, params)` | `PATCH /api/epharmacy/orders/{order_id}/cancel` |
| | `confirmOrder(orderId, params)` | `POST /api/epharmacy/orders/{order_id}/confirm` |
| wallet | `getCustomerWallet(companySlug, params)` | `GET /api/{company_slug}/customers/wallet` |
| | `listCustomerPlans(companySlug, params)` | `GET /api/{company_slug}/customers/plans` |
| preRegistration | `getAccessToken` (getPreRegistrationAccessToken) | `GET /api/pre_registration/access-token` |
| | `create` (createPreRegistrations) | `POST /v1/corporate/pre_registrations` |
| | `update` (updatePreRegistrations) | `POST /v1/corporate/pre_registrations/update` |
| | `deactivate` (deactivatePreRegistrations) | `POST /v1/corporate/pre_registrations/deactivate` |
| | `getStatus(requestId)` (getPreRegistrationStatus) | `GET /v1/corporate/pre_registrations/{request_id}/status` |
| testing (staging only) | `simulateAppointmentStatus(appointmentId, params)` | `POST /api/appointments/{appointment_id}/update_status` |
| | `simulateConsultationStatus(appointmentId, params)` | `PATCH /api/consultations/{appointment_id}/update_status` |
| | `simulateOrderStatus(orderId, params)` | `PATCH /api/epharmacy/orders/{order_id}/update_status` |

Path parameters are positional; query parameters and JSON bodies are a single object with
the API's own field names. On the ePharmacy GET endpoints, pass the member as
`customer_details: { api_customer_id }` (sent as `customer_details[api_customer_id]`).

Request and response types are exported by name (`CreateAppointmentParams`,
`BookingDetails`, `CartResponse`, ...), and the full generated `paths`, `operations` and
`components` types are exported too.

### File uploads

Upload methods accept a `Blob`/`File`, raw bytes (`Buffer`, `Uint8Array`, `ArrayBuffer`), or
`{ data, filename, contentType }`. The API accepts PDF, JPEG and PNG; give raw bytes a
filename with the right extension (or a `contentType`).

```ts
import { readFile } from 'node:fs/promises';

await client.consultations.uploadDocuments('APT1A2B3C4D5', [
  { name: 'Blood report', file: { data: await readFile('report.pdf'), filename: 'report.pdf' } },
]);

await client.pharmacy.digitizePrescription(
  {
    customers: [{ name: 'Jane Doe', api_customer_id: 'CUST1001', mobile_number: '9999999999', gender: 'female', dob: '1990-08-24' }],
    files: [{ data: await readFile('rx.jpg'), filename: 'rx.jpg' }],
  },
  { idempotencyKey: 'rx-upload-0001' },
);

await client.pharmacy.updateCart({
  customer_details: { api_customer_id: 'CUST1001' },
  prescription_files: [new File([await readFile('rx.pdf')], 'rx.pdf', { type: 'application/pdf' })],
});
```

### Binary responses

Vouchers are returned as an `ArrayBuffer`:

```ts
import { writeFile } from 'node:fs/promises';

const pdf = await client.appointments.getVoucher('APT1A2B3C4D5');
await writeFile('voucher.pdf', Buffer.from(pdf));
```

### Pre-registration

Register, update and deactivate members and dependants in bulk (at most 250 rows per call).
Each write returns a `request_id`; poll `getStatus` until `status` is `completed`. Entity
options (`entityId`, `secretKey`) don't apply here: each row names its `company_id`.

```ts
const client = new Hlthstack({
  preRegistrationUsername: process.env.HLTHSTACK_PREREG_USERNAME!,
  preRegistrationPassword: process.env.HLTHSTACK_PREREG_PASSWORD!,
  environment: 'staging',
});

const { request_id } = await client.preRegistration.create({
  employees: [
    {
      employee_code: 'EMP1001', company_id: '1001', first_name: 'Jane', last_name: 'Doe',
      email: 'jane.doe@example.com', date_of_birth: '24-08-1990', gender: 'Female',
      mobile_number: '9999999999', vip: 'No', entity_name: '', employee_office_location: 'Hyderabad',
      department: 'Engineering', grade: 'B', date_of_joining: '01-01-2026',
    },
  ],
});

let result = await client.preRegistration.getStatus(request_id);
while (result.status !== 'completed') {
  await new Promise((r) => setTimeout(r, 5_000));
  result = await client.preRegistration.getStatus(request_id);
}
console.log(result.success_records.length, result.failure_records.map((r) => r.errors));
```

Every key the spec marks required must be present in each `create` row, even when empty:
the API silently drops rows that miss one, and the types enforce this. `update` takes only
the identifier and the fields to change; `deactivate` takes employee emails and dependant
mobile numbers. See the
[pre-registration guide](https://github.com/hlthstack/integration-guide/blob/main/docs/pre-registration.md).

### Staging simulators

`client.testing.*` moves bookings and orders through their lifecycle on **staging** and fires
the same webhooks real updates would. These routes don't exist in production, and the client
refuses to call them when `environment` is `production`.

```ts
const staging = new Hlthstack({ username, password, environment: 'staging' });
await staging.testing.simulateAppointmentStatus('APT1A2B3C4D5', { status: 'confirm' });
```

## Validation

Before any network call (and before fetching a token), every method checks its input
against the rules in the OpenAPI spec and throws `HlthstackValidationError` listing **every**
problem it found:

- required fields, types (including nullable fields), enums;
- patterns, exactly as the server applies them (some are deliberately unanchored), lengths,
  numeric ranges, array sizes, and the `date`, `date-time`, `uri` and `uuid` formats;
- path parameters, such as the shape of `booking_id` and `appointment_id`;
- cross-field rules: fields required together or only in some cases (`address` for home
  collection, `latitude`/`longitude` without `pincode`, `selected_chemist_id` for store
  pickup...), "at least one of" and "only one of" groups, unique `api_customer_id`s and
  product ids, at most 250 pre-registration rows;
- dates relative to today: members at least one year old, `appointment_date_time` later than
  now for consultations (a time without an offset is read as IST), dates of birth not in the
  future. "Today" is the API's calendar day in India Standard Time;
- pincodes: an Indian address must not mention a 6-digit pincode other than its own;
- uploads: file count, size and type (give raw bytes a `filename` or `contentType`).

```ts
import { HlthstackValidationError } from 'hlthstack';

try {
  await client.appointments.create({
    provider_id: 1001,
    appointment_date_time: '2026-12-15T02:30:00Z',
    appointment_type: 'home_collection',
    service_name: 'ahc',
    customers: [
      { name: 'Jane Doe', dob: '1990-08-24', mobile_number: '+919999999999', api_customer_id: 'CUST1001', gender: 'female', package_ids: [1001] },
      { name: 'John Doe', dob: '2026-02-01', mobile_number: '9999999998', api_customer_id: 'CUST1001', gender: 'male', package_ids: [1001] },
    ],
  });
} catch (error) {
  if (error instanceof HlthstackValidationError) {
    error.operation; // 'createAppointment'
    error.errors;
    // [
    //   { path: 'customers[0].mobile_number', message: 'must match ^[0-9]{10}$', rule: 'pattern' },
    //   { path: 'address', message: 'is required when appointment_type is home_collection', rule: 'required_if' },
    //   { path: 'customers[1].api_customer_id', message: 'duplicates customers[0].api_customer_id ("CUST1001")', rule: 'unique_by' },
    //   { path: 'customers[1].dob', message: 'must be on or before 2025-11-10 (at least 1 year(s) ago)', rule: 'relative_date' },
    // ]
    error.message;
    // 'Invalid createAppointment request (4 problems): customers[0].mobile_number: must match ^[0-9]{10}$; address: ...'
  }
}
```

`path` uses the method's own field names (`customers[0].api_customer_id`); it is empty when a
problem concerns the input as a whole (for example "send at least one of api_customer_id,
customer_id"). `rule` is the JSON Schema keyword or the spec's rule kind that failed.

Checks that need data stored on the server, such as plan benefits, package ids, slot
availability, whether an order or appointment exists, or whether an amount matches the
order, are still made by the API and come back as `HlthstackError`.

**Escape hatch.** If the API accepts something this version of the library rejects, turn
validation off for one call or for the client, and please open an issue:

```ts
await client.appointments.create(params, { validate: false });
const unchecked = new Hlthstack({ username, password, environment: 'staging', validate: false });
```

## Errors

Any non-2xx response throws an `HlthstackError` (invalid input is rejected earlier with an
`HlthstackValidationError`, see [Validation](#validation)):

```ts
import { HlthstackError, HlthstackConnectionError } from 'hlthstack';

try {
  await client.appointments.reschedule('APT1A2B3C4D5', { appointment_date_time: '2026-01-16T02:30:00Z' });
} catch (error) {
  if (error instanceof HlthstackError) {
    error.status;    // 400
    error.body;      // parsed JSON, or the text body (e.g. 'HTTP Token: Access denied.')
    error.messages;  // ['This appointment cannot be rescheduled']
    error.requestId; // x-request-id response header, when present
    error.headers;   // all response headers
  } else if (error instanceof HlthstackConnectionError) {
    error.timedOut;  // network failure or client-side timeout
  }
}
```

The API uses several error body shapes (`{errors: {field: [...]}}`, `{errors: {messages:
[...]}}`, `{errors: [...]}`, `{message}`, `{success: false, message}`, `{msg, recall}`,
`{error}`). `body` keeps the original; `messages` flattens all of them into strings.

Some ePharmacy responses are HTTP 200 with nested `success: false` (for example
`getFulfillmentOptions`); those are returned, not thrown, so check the flags.

The client does not retry automatically, except once after a `401`. Retry 5xx, 409 and
connection errors with backoff yourself, but don't blindly retry `appointments.create` or
consultation creation: check with `appointments.get` or your webhooks first. See the
[errors guide](https://github.com/hlthstack/integration-guide/blob/main/docs/errors.md).

## Webhooks

hlthstack signs every webhook with an HS256 JWT in the `Signature` header. The JWT does not
cover the body, so `verifyWebhookSignature` checks the signature, that the ids in the claims
match the body, and that the `timestamp` claim is recent (5 minutes by default):

```ts
import express from 'express';
import { verifyWebhookSignature, WebhookVerificationError } from 'hlthstack';

const app = express();
app.use(express.json());

app.post('/hlthstack/webhooks', async (req, res) => {
  let event;
  try {
    ({ payload: event } = await verifyWebhookSignature({
      payload: req.body,                 // parsed JSON or the raw body
      signature: req.get('Signature'),
      secret: process.env.HLTHSTACK_WEBHOOK_SECRET!,
      // toleranceSeconds: 300,
    }));
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.sendStatus(401);
    throw error;
  }
  res.sendStatus(200); // acknowledge fast, process asynchronously
  enqueue(event);
});
```

It resolves with `{ claims, payload }`. `payload` is typed as `WebhookPayload`, a union of
the seven webhook bodies:

| Type | `type` | Sent for |
|---|---|---|
| `AppointmentStatusUpdateWebhook` | `status_update` / `reports_upload` | Health checkup status changes |
| `ConsultationStatusUpdateWebhook` | `status_update` / `reports_upload` | Consultation status changes |
| `LabResultsWebhook` | `lab_results` | Digitized lab results |
| `PharmacyOrderStatusUpdateWebhook` | `status_update` | Pharmacy order status changes |
| `PharmacyAdditionalPaymentRequiredWebhook` | `additional_payment_required` | Partner-collected orders |
| `PharmacyPostBillingWebhook` | `post_billing` | Partner-collected orders |
| `PrescriptionDigitizedWebhook` | `digitization_results` | Prescription digitization finished |

Appointment and pharmacy events share a URL: appointment payloads have `appointment_id`,
pharmacy payloads have `order_id`. Delivery order isn't guaranteed; use `claims.timestamp`
and the GET endpoints to reconcile. See the
[webhooks guide](https://github.com/hlthstack/integration-guide/blob/main/docs/webhooks.md).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

[`openapi/openapi.yaml`](../openapi/openapi.yaml) is a copy of the spec from
[hlthstack/integration-guide](https://github.com/hlthstack/integration-guide), which is the
source of truth. After updating it, run `npm run generate` to regenerate
`src/generated/openapi.ts` (types) and `src/generated/validation.ts` (the request schemas and
`x-hlthstack-rules` used for validation), then add or adjust methods; `test/coverage.test.ts`
fails if an operation has no method. `scripts/build-validation.mjs` stops with an error when
the spec uses a schema keyword, format or rule it does not support: extend it and
`src/validation.ts` together.

`npm install` (and `npm install github:hlthstack/js` in other projects) runs the `prepare`
script, which builds `dist/`.

`test/api-examples.test.mjs` runs the plain-API examples in [`examples/api/`](../examples/api/)
against a local mock server, so the [plain REST API guide](api-integration.md) stays correct.

