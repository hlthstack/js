import { path, type RequestOptions, type Transport } from '../core.js';
import type {
  CustomerPlansResponse,
  GetCustomerWalletParams,
  ListCustomerPlansParams,
  WalletResponse,
} from '../types.js';

/** Member benefit wallets and plan subscriptions. */
export class Wallet {
  constructor(private readonly transport: Transport) {}

  /**
   * `GET /api/{company_slug}/customers/wallet` (getCustomerWallet). Identify the member by
   * `api_customer_id` or `customer_id`.
   */
  getCustomerWallet(
    companySlug: string,
    params: GetCustomerWalletParams,
    options?: RequestOptions,
  ): Promise<WalletResponse> {
    return this.transport.request(
      { method: 'GET', path: path`/api/${companySlug}/customers/wallet`, query: params },
      options,
    );
  }

  /** `GET /api/{company_slug}/customers/plans` (listCustomerPlans). */
  listCustomerPlans(
    companySlug: string,
    params: ListCustomerPlansParams,
    options?: RequestOptions,
  ): Promise<CustomerPlansResponse> {
    return this.transport.request(
      { method: 'GET', path: path`/api/${companySlug}/customers/plans`, query: params },
      options,
    );
  }
}
