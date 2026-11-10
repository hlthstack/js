import { path, type RequestOptions, type Transport } from '../core.js';
import { toBlob } from '../uploads.js';
import type {
  CancelOrderParams,
  CancelOrderResponse,
  CartResponse,
  ConfirmOrderParams,
  ConfirmOrderResponse,
  CreateOrderParams,
  CreateOrderResponse,
  DigitizationAccepted,
  DigitizationStatus,
  DigitizePrescriptionParams,
  FulfillmentOptions,
  GetCartParams,
  GetFulfillmentOptionsParams,
  GetOrderParams,
  GetOrderResponse,
  ListOrdersParams,
  ListOrdersResponse,
  MedicineSearchResponse,
  OrderPaymentDetails,
  OrderPaymentDetailsParams,
  SearchMedicinesParams,
  UpdateCartParams,
  UpdateCartWithFilesParams,
} from '../types.js';

export interface DigitizePrescriptionOptions extends RequestOptions {
  /** Sent as `Idempotency-Key`: repeating a key returns the original request instead of a duplicate. */
  idempotencyKey?: string;
}

/** ePharmacy: medicine search, prescription digitization, cart, pricing and orders. */
export class Pharmacy {
  constructor(private readonly transport: Transport) {}

  /** `GET /api/epharmacy/medicines/search` (searchMedicines). `name` needs at least 3 characters. */
  searchMedicines(params: SearchMedicinesParams, options?: RequestOptions): Promise<MedicineSearchResponse> {
    return this.transport.request(
      { operation: 'searchMedicines', method: 'GET', path: '/api/epharmacy/medicines/search', query: params },
      options,
    );
  }

  /**
   * `POST /api/prescriptions/digitize` (digitizePrescription). Multipart upload; resolves with
   * the `202` body. Pass `idempotencyKey` to make retries safe.
   */
  async digitizePrescription(
    params: DigitizePrescriptionParams,
    options: DigitizePrescriptionOptions = {},
  ): Promise<DigitizationAccepted> {
    const { idempotencyKey, ...requestOptions } = options;
    this.transport.validate('digitizePrescription', { form: params }, requestOptions);
    const form = new FormData();
    for (const customer of params.customers) {
      form.append('customers[][name]', customer.name);
      form.append('customers[][api_customer_id]', customer.api_customer_id);
      form.append('customers[][mobile_number]', customer.mobile_number);
      form.append('customers[][gender]', customer.gender);
      form.append('customers[][dob]', customer.dob);
    }
    if (params.plan_id !== undefined) form.append('plan_id', params.plan_id);
    for (const file of params.files) {
      const { blob, filename } = toBlob(file);
      form.append('files[]', blob, filename);
    }
    return this.transport.request(
      {
        method: 'POST',
        path: '/api/prescriptions/digitize',
        form,
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      },
      requestOptions,
    );
  }

  /** `GET /api/prescriptions/digitize/{request_id}` (getPrescriptionDigitization). */
  getPrescriptionDigitization(requestId: string, options?: RequestOptions): Promise<DigitizationStatus> {
    return this.transport.request(
      {
        operation: 'getPrescriptionDigitization',
        method: 'GET',
        path: path`/api/prescriptions/digitize/${requestId}`,
        params: { request_id: requestId },
      },
      options,
    );
  }

  /** `GET /api/epharmacy/cart` (getCart). One cart per member per plan. */
  getCart(params: GetCartParams, options?: RequestOptions): Promise<CartResponse> {
    return this.transport.request({ operation: 'getCart', method: 'GET', path: '/api/epharmacy/cart', query: params }, options);
  }

  /**
   * `PATCH /api/epharmacy/cart` (updateCart). Find-or-create and merge; atomic.
   *
   * Pass `prescription_files` to upload prescriptions: the request is then sent as
   * `multipart/form-data` with `customer_details[api_customer_id]`, `plan_id` and
   * `prescription_files[]` (the multipart fields the spec defines). Send other changes in a
   * separate JSON call.
   */
  async updateCart(
    params: UpdateCartParams | UpdateCartWithFilesParams,
    options?: RequestOptions,
  ): Promise<CartResponse> {
    if (params && typeof params === 'object' && 'prescription_files' in params) {
      this.transport.validate('updateCart', { form: params }, options);
      const form = new FormData();
      form.append('customer_details[api_customer_id]', params.customer_details.api_customer_id);
      if (params.plan_id !== undefined) form.append('plan_id', params.plan_id);
      for (const file of params.prescription_files) {
        const { blob, filename } = toBlob(file);
        form.append('prescription_files[]', blob, filename);
      }
      return this.transport.request({ method: 'PATCH', path: '/api/epharmacy/cart', form }, options);
    }
    return this.transport.request(
      { operation: 'updateCart', method: 'PATCH', path: '/api/epharmacy/cart', body: params },
      options,
    );
  }

  /**
   * `GET /api/epharmacy/fulfillment_options` (getFulfillmentOptions). Slow (3-8 s). Check the
   * nested `success` flags, not just the HTTP status.
   */
  getFulfillmentOptions(
    params: GetFulfillmentOptionsParams,
    options?: RequestOptions,
  ): Promise<FulfillmentOptions> {
    return this.transport.request(
      {
        operation: 'getFulfillmentOptions',
        method: 'GET',
        path: '/api/epharmacy/fulfillment_options',
        query: params,
      },
      options,
    );
  }

  /** `POST /api/epharmacy/orders/payment_details` (getOrderPaymentDetails). Note: `selected_delivery_option`. */
  getOrderPaymentDetails(
    params: OrderPaymentDetailsParams,
    options?: RequestOptions,
  ): Promise<OrderPaymentDetails> {
    return this.transport.request(
      {
        operation: 'getOrderPaymentDetails',
        method: 'POST',
        path: '/api/epharmacy/orders/payment_details',
        body: params,
      },
      options,
    );
  }

  /** `POST /api/epharmacy/orders` (createOrder). Note: `delivery_option`. */
  createOrder(params: CreateOrderParams, options?: RequestOptions): Promise<CreateOrderResponse> {
    return this.transport.request(
      { operation: 'createOrder', method: 'POST', path: '/api/epharmacy/orders', body: params },
      options,
    );
  }

  /** `GET /api/epharmacy/orders` (listOrders). Newest first. */
  listOrders(params: ListOrdersParams, options?: RequestOptions): Promise<ListOrdersResponse> {
    return this.transport.request(
      { operation: 'listOrders', method: 'GET', path: '/api/epharmacy/orders', query: params },
      options,
    );
  }

  /** `GET /api/epharmacy/orders/{order_id}` (getOrder). The source of truth for an order. */
  getOrder(orderId: string, params: GetOrderParams, options?: RequestOptions): Promise<GetOrderResponse> {
    return this.transport.request(
      {
        operation: 'getOrder',
        method: 'GET',
        path: path`/api/epharmacy/orders/${orderId}`,
        params: { order_id: orderId },
        query: params,
      },
      options,
    );
  }

  /** `PATCH /api/epharmacy/orders/{order_id}/cancel` (cancelOrder). */
  cancelOrder(orderId: string, params: CancelOrderParams, options?: RequestOptions): Promise<CancelOrderResponse> {
    return this.transport.request(
      {
        operation: 'cancelOrder',
        method: 'PATCH',
        path: path`/api/epharmacy/orders/${orderId}/cancel`,
        params: { order_id: orderId },
        body: params,
      },
      options,
    );
  }

  /**
   * `POST /api/epharmacy/orders/{order_id}/confirm` (confirmOrder). Partner-collected flow only.
   * Safe to retry; on a 409 back off and retry.
   */
  confirmOrder(
    orderId: string,
    params: ConfirmOrderParams,
    options?: RequestOptions,
  ): Promise<ConfirmOrderResponse> {
    return this.transport.request(
      {
        operation: 'confirmOrder',
        method: 'POST',
        path: path`/api/epharmacy/orders/${orderId}/confirm`,
        params: { order_id: orderId },
        body: params,
      },
      options,
    );
  }
}
