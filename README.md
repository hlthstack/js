# hlthstack for JavaScript and TypeScript

[![Release](https://img.shields.io/github/v/release/hlthstack/js)](https://github.com/hlthstack/js/releases)
[![CI](https://github.com/hlthstack/js/actions/workflows/ci.yml/badge.svg)](https://github.com/hlthstack/js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Integrate the [hlthstack](https://www.hlthstack.io/) partner REST API from Node.js: health
checkups and lab tests, in-clinic and online consultations, ePharmacy orders, benefit wallets
and member pre-registration.

This repo has two ways to do it, and both talk to the same API with the same JSON:

- the `hlthstack` **SDK** (the package in this repo), or
- **plain HTTP calls** with `fetch` and no dependency.

> [!CAUTION]
> **Server-side only.** Your API credentials, access tokens, entity secret key and webhook
> secret must never be shipped to a browser or mobile app. Call hlthstack from your backend.

## Choose how to integrate

| | SDK | Plain REST API |
|---|---|---|
| **Install** | `npm install github:hlthstack/js#v1.0.2` | Nothing: any HTTP client (Node 18+ `fetch`) |
| **Authentication** | Tokens fetched, cached and refreshed for you (including pre-registration) | You call the token endpoints and refresh before expiry |
| **Input validation** | Every spec rule checked before sending | You check inputs, or rely on the server's `400`/`422` |
| **Types** | TypeScript types for every request and response | Read the OpenAPI spec |
| **Errors** | One `HlthstackError` with the messages from every error shape | You parse the API's error shapes |
| **Webhooks** | `verifyWebhookSignature()` helper | Verify the HS256 JWT yourself (`node:crypto`) |
| **Guide** | [SDK integration guide](docs/sdk-integration.md) | [Plain REST API guide](docs/api-integration.md) |

> [!TIP]
> Pick the SDK unless you can't add a dependency or you work in another stack. You can mix
> them: the plain API guide ends with a mapping to SDK methods.

## SDK quickstart

Install a release tag from GitHub:

```sh
npm install github:hlthstack/js#v1.0.2
```

Create a client, then find providers and their slots:

```ts
import { Hlthstack } from 'hlthstack';

const client = new Hlthstack({
  username: process.env.HLTHSTACK_USERNAME!,
  password: process.env.HLTHSTACK_PASSWORD!,
  environment: 'staging', // or 'production'
});

// Use the package id and plan id issued to you at onboarding.
const { providers } = await client.appointments.listProviders({
  service_name: 'ahc',
  package_ids: 'YOUR_PACKAGE_ID',
  plan_id: 'YOUR_PLAN_ID',
  pincode: '500081',
});
const slots = await client.appointments.listSlots(providers[0]!.provider_id!, 'ahc', {
  package_ids: 'YOUR_PACKAGE_ID',
  pincode: '500081',
});
```

**Next:**

- Booking, configuration, multi-entity partners, uploads, pre-registration, validation, errors
  and webhooks: [docs/sdk-integration.md](docs/sdk-integration.md).
- Runnable example: [`examples/sdk/quickstart.ts`](examples/sdk/quickstart.ts).

## Plain REST API quickstart

Get an access token with HTTP Basic, then call an endpoint with it:

```js
const BASE_URL = 'https://staging-api.hlthstack.io';
const basic = Buffer.from(`${process.env.HLTHSTACK_USERNAME}:${process.env.HLTHSTACK_PASSWORD}`).toString('base64');

const { access_token } = await (
  await fetch(`${BASE_URL}/api/get-access-token`, { headers: { Authorization: `Basic ${basic}` } })
).json();

const res = await fetch(`${BASE_URL}/api/providers?service_name=ahc&package_ids=1001&pincode=500081`, {
  headers: { Authorization: `Bearer ${access_token}` },
});
console.log(await res.json());
```

**Next:**

- Token caching and refresh, the full booking flow, uploads, pre-registration, errors,
  validation and webhook verification: [docs/api-integration.md](docs/api-integration.md).
- Runnable scripts: [`examples/api/`](examples/api/).

## Reference

| Resource | What it covers |
|---|---|
| [Getting started](https://github.com/hlthstack/integration-guide/blob/main/docs/getting-started.md) | Access to go-live |
| [API reference](https://developers.hlthstack.io) | Built from the OpenAPI spec |
| [Postman docs](https://documenter.getpostman.com/view/32733686/2sBYHbrFjt) | Code samples and a Run in Postman button |
| [REST API guides](https://github.com/hlthstack/integration-guide/tree/main/docs) | Integration guides for the REST API |
| [OpenAPI spec](https://github.com/hlthstack/integration-guide/blob/main/openapi/openapi.yaml) | The spec; a copy is in [`openapi/openapi.yaml`](openapi/openapi.yaml) |

| Environment | Base URL |
|---|---|
| Production | `https://api.hlthstack.io` |
| Staging | `https://staging-api.hlthstack.io` |

## Development

Install, type-check, test and build:

```sh
npm install
npm run typecheck
npm test
npm run build
```

See [Development](docs/sdk-integration.md#development) in the SDK guide.

## License

MIT
