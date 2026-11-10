import { path, type RequestOptions, type Transport } from '../core.js';
import { HlthstackBaseError } from '../errors.js';
import type {
  Messages,
  SimulateAppointmentStatusParams,
  SimulateConsultationStatusParams,
  SimulateOrderStatusParams,
  SimulateOrderStatusResponse,
} from '../types.js';

/**
 * **Staging only.** Moves bookings and orders through their lifecycle and fires the same
 * webhooks real updates would. These routes do not exist in production; the client refuses to
 * call them when `environment` is `production`.
 */
export class Testing {
  constructor(private readonly transport: Transport) {}

  private assertStaging(): void {
    if (this.transport.environment === 'production') {
      throw new HlthstackBaseError(
        'client.testing.* endpoints exist only on staging; create the client with environment: "staging"',
      );
    }
  }

  /** `POST /api/appointments/{appointment_id}/update_status` (simulateAppointmentStatus). Staging only. */
  async simulateAppointmentStatus(
    appointmentId: string,
    params: SimulateAppointmentStatusParams,
    options?: RequestOptions,
  ): Promise<Messages> {
    this.assertStaging();
    return this.transport.request(
      { method: 'POST', path: path`/api/appointments/${appointmentId}/update_status`, body: params },
      options,
    );
  }

  /** `PATCH /api/consultations/{appointment_id}/update_status` (simulateConsultationStatus). Staging only. */
  async simulateConsultationStatus(
    appointmentId: string,
    params: SimulateConsultationStatusParams,
    options?: RequestOptions,
  ): Promise<Messages> {
    this.assertStaging();
    return this.transport.request(
      { method: 'PATCH', path: path`/api/consultations/${appointmentId}/update_status`, body: params },
      options,
    );
  }

  /** `PATCH /api/epharmacy/orders/{order_id}/update_status` (simulateOrderStatus). Staging only. */
  async simulateOrderStatus(
    orderId: string,
    params: SimulateOrderStatusParams,
    options?: RequestOptions,
  ): Promise<SimulateOrderStatusResponse> {
    this.assertStaging();
    return this.transport.request(
      { method: 'PATCH', path: path`/api/epharmacy/orders/${orderId}/update_status`, body: params },
      options,
    );
  }
}
