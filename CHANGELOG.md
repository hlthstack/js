# Changelog

Releases of the hlthstack JavaScript/TypeScript SDK. Versions follow [semantic versioning](https://semver.org/):
a major version for breaking changes, a minor version for new features, a patch version
for fixes. Each release is a git tag (`v1.0.2`) with a GitHub release; pin one in your
dependency (`github:hlthstack/js#v1.0.2`).

The SDK's major and minor versions are independent of the API's. Each release names the
API spec version it was built from
([hlthstack/integration-guide](https://github.com/hlthstack/integration-guide/blob/main/CHANGELOG.md)).

## 1.0.2 (2026-11-17)

Built from API spec 1.0.2.

- `service_name` (provider search and health-checkup booking) accepts only the services
  partners book through the API: `ahc`, `dental`, `vision`, `fitness`, `pharmacy`,
  `flu_vaccination`, `specialist_consultation`, `inclinic_consultation`,
  `consultation24x7` and `nhc`. Other values are stopped before the request is sent.

## 1.0.1 (2026-11-17)

Built from API spec 1.0.1.

- Booking a consultation (`createInclinicConsultation`, `createSpecialistConsultation`)
  now requires `service_mode`, as the API does: a request without it is stopped before it
  is sent instead of failing with `service mode can't be blank`.
- The bundled spec explains each endpoint's rules: booking hours and notice, reschedule and
  cancel limits, co-pay links, statuses and webhooks.

## 1.0.0 (2026-11-17)

First stable release, built from API spec 1.0.0.

- Health checkups and lab tests, consultations, ePharmacy,
  wallet, pre-registration, and staging's lifecycle simulators.
- Access tokens (including the pre-registration token) fetched, cached and refreshed for
  you, with one retry after a 401.
- Requests checked against the spec's validation rules before they are sent.
- Webhook signature verification.
- Cancelling a booking or appointment takes an optional `reason`.
