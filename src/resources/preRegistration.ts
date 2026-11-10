import { path, type RequestOptions, type Transport } from '../core.js';
import type {
  CreatePreRegistrationsParams,
  DeactivatePreRegistrationsParams,
  PreRegistrationAccepted,
  PreRegistrationAccessToken,
  PreRegistrationStatus,
  UpdatePreRegistrationsParams,
} from '../types.js';

/**
 * Register, update and deactivate members and their dependants in bulk. Uses the
 * pre-registration credentials (`preRegistrationUsername` / `preRegistrationPassword`) and
 * sends their token as `X-EKINCARE-KEY`. Writes are asynchronous: each returns a `request_id`
 * to poll with `getStatus`.
 */
export class PreRegistration {
  constructor(private readonly transport: Transport) {}

  /**
   * `GET /api/pre_registration/access-token` (getPreRegistrationAccessToken). Returns the cached
   * token while it is valid (refreshed 5 minutes before expiry); pass `forceRefresh` to fetch a
   * new one. `expires_at` looks like `2026-01-15 07:16:21 UTC`.
   */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<PreRegistrationAccessToken> {
    return this.transport.getPreRegistrationAccessToken(options);
  }

  /**
   * `POST /v1/corporate/pre_registrations` (createPreRegistrations). Every required key must be
   * present in every row (empty values allowed); rows missing one are dropped silently.
   * At most 250 rows in total.
   */
  create(
    params: CreatePreRegistrationsParams,
    options?: RequestOptions,
  ): Promise<PreRegistrationAccepted> {
    return this.transport.preRegistrationRequest(
      { operation: 'createPreRegistrations', method: 'POST', path: '/v1/corporate/pre_registrations', body: params },
      options,
    );
  }

  /** `POST /v1/corporate/pre_registrations/update` (updatePreRegistrations). */
  update(
    params: UpdatePreRegistrationsParams,
    options?: RequestOptions,
  ): Promise<PreRegistrationAccepted> {
    return this.transport.preRegistrationRequest(
      {
        operation: 'updatePreRegistrations',
        method: 'POST',
        path: '/v1/corporate/pre_registrations/update',
        body: params,
      },
      options,
    );
  }

  /**
   * `POST /v1/corporate/pre_registrations/deactivate` (deactivatePreRegistrations). `employees`
   * are emails, `dependants` are mobile numbers. Deactivating an employee deactivates their
   * dependants too.
   */
  deactivate(
    params: DeactivatePreRegistrationsParams,
    options?: RequestOptions,
  ): Promise<PreRegistrationAccepted> {
    return this.transport.preRegistrationRequest(
      {
        operation: 'deactivatePreRegistrations',
        method: 'POST',
        path: '/v1/corporate/pre_registrations/deactivate',
        body: params,
      },
      options,
    );
  }

  /**
   * `GET /v1/corporate/pre_registrations/{request_id}/status` (getPreRegistrationStatus). Poll
   * until `status` is `completed`.
   */
  getStatus(requestId: string, options?: RequestOptions): Promise<PreRegistrationStatus> {
    return this.transport.preRegistrationRequest(
      {
        operation: 'getPreRegistrationStatus',
        method: 'GET',
        path: path`/v1/corporate/pre_registrations/${requestId}/status`,
        params: { request_id: requestId },
      },
      options,
    );
  }
}
