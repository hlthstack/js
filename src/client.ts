import { Transport, type ClientOptions, type Environment } from './core.js';
import { Appointments } from './resources/appointments.js';
import { Consultations } from './resources/consultations.js';
import { Pharmacy } from './resources/pharmacy.js';
import { PreRegistration } from './resources/preRegistration.js';
import { Testing } from './resources/testing.js';
import { Wallet } from './resources/wallet.js';
import type { AccessToken } from './types.js';

/** Authentication. Tokens are fetched, cached and refreshed automatically; you rarely need this. */
export class Auth {
  constructor(private readonly transport: Transport) {}

  /**
   * `GET /api/get-access-token` (getAccessToken). Returns the cached token while it is valid
   * (refreshed 5 minutes before `expires_at`); pass `forceRefresh` to fetch a new one.
   */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<AccessToken> {
    return this.transport.getAccessToken(options);
  }
}

/**
 * Client for the hlthstack partner REST API. Server-side only: never ship your credentials,
 * tokens or secret keys to a browser or mobile app.
 *
 * ```ts
 * const client = new Hlthstack({ username, password, environment: 'staging' });
 * const { providers } = await client.appointments.listProviders({ service_name: 'ahc', package_ids: '1001', pincode: '500081' });
 * ```
 */
export class Hlthstack {
  readonly environment: Environment;
  readonly baseUrl: string;
  readonly auth: Auth;
  /** Health checkups, lab tests, dental, vision and vaccinations. */
  readonly appointments: Appointments;
  /** In-clinic and online specialist consultations. */
  readonly consultations: Consultations;
  /** ePharmacy: medicines, prescriptions, cart and orders. */
  readonly pharmacy: Pharmacy;
  /** Benefit wallets and plan subscriptions. */
  readonly wallet: Wallet;
  /** Bulk member and dependant registration (separate credentials). */
  readonly preRegistration: PreRegistration;
  /** Staging-only lifecycle simulators. */
  readonly testing: Testing;

  constructor(options: ClientOptions) {
    const transport = new Transport(options);
    this.environment = transport.environment;
    this.baseUrl = transport.baseUrl;
    this.auth = new Auth(transport);
    this.appointments = new Appointments(transport);
    this.consultations = new Consultations(transport);
    this.pharmacy = new Pharmacy(transport);
    this.wallet = new Wallet(transport);
    this.preRegistration = new PreRegistration(transport);
    this.testing = new Testing(transport);
  }
}
