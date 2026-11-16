import { path, type RequestOptions, type Transport } from '../core.js';
import type {
  AppointmentReportsResponse,
  BookingDetails,
  CancelParams,
  CreateAppointmentParams,
  CreateAppointmentResponse,
  GetAppointmentParams,
  LabResults,
  ListProvidersParams,
  ListSlotsParams,
  Message,
  PartialResult,
  ProvidersResponse,
  RescheduleAppointmentParams,
  SlotsResponse,
} from '../types.js';

/** Health checkups, lab tests, dental, vision and vaccinations. */
export class Appointments {
  constructor(private readonly transport: Transport) {}

  /** `GET /api/providers` (listProviders). Requires `pincode` or both `latitude` and `longitude`. */
  listProviders(params: ListProvidersParams, options?: RequestOptions): Promise<ProvidersResponse> {
    return this.transport.request({ operation: 'listProviders', method: 'GET', path: '/api/providers', query: params }, options);
  }

  /**
   * `GET /api/providers/{provider_id}/{benefit_type}/slots` (listSlots). Read `booking_slots`
   * and send a slot's `utc_slot_time` as `appointment_date_time` when booking.
   */
  listSlots(
    providerId: number,
    benefitType: string,
    params: ListSlotsParams,
    options?: RequestOptions,
  ): Promise<SlotsResponse> {
    return this.transport.request(
      {
        operation: 'listSlots',
        method: 'GET',
        path: path`/api/providers/${providerId}/${benefitType}/slots`,
        params: { provider_id: providerId, benefit_type: benefitType },
        query: params,
      },
      options,
    );
  }

  /**
   * `POST /api/appointments` (createAppointment). Do not blindly retry on failure: check with
   * {@link get} or your webhooks whether the booking was created first.
   */
  create(params: CreateAppointmentParams, options?: RequestOptions): Promise<CreateAppointmentResponse> {
    return this.transport.request({ operation: 'createAppointment', method: 'POST', path: '/api/appointments', body: params }, options);
  }

  /** `GET /api/appointments` (getAppointment). Pass `booking_id`, and optionally `appointment_id`. */
  get(params: GetAppointmentParams, options?: RequestOptions): Promise<BookingDetails> {
    return this.transport.request({ operation: 'getAppointment', method: 'GET', path: '/api/appointments', query: params }, options);
  }

  /** `PATCH /api/bookings/{booking_id}/reschedule` (rescheduleBooking). May partially succeed. */
  rescheduleBooking(
    bookingId: string,
    params: RescheduleAppointmentParams,
    options?: RequestOptions,
  ): Promise<PartialResult> {
    return this.transport.request(
      {
        operation: 'rescheduleBooking',
        method: 'PATCH',
        path: path`/api/bookings/${bookingId}/reschedule`,
        params: { booking_id: bookingId },
        body: params,
      },
      options,
    );
  }

  /**
   * `PATCH /api/bookings/{booking_id}/cancel` (cancelBooking). May partially succeed. Pass
   * `{ reason }` to record why; without it hlthstack records `Cancelled by your booking partner`.
   */
  cancelBooking(bookingId: string, options?: RequestOptions): Promise<PartialResult>;
  cancelBooking(bookingId: string, params: CancelParams, options?: RequestOptions): Promise<PartialResult>;
  cancelBooking(
    bookingId: string,
    paramsOrOptions?: CancelParams | RequestOptions,
    maybeOptions?: RequestOptions,
  ): Promise<PartialResult> {
    const [body, options] = cancelArgs(paramsOrOptions, maybeOptions);
    return this.transport.request(
      {
        operation: 'cancelBooking',
        method: 'PATCH',
        path: path`/api/bookings/${bookingId}/cancel`,
        params: { booking_id: bookingId },
        body,
      },
      options,
    );
  }

  /** `PATCH /api/appointments/{appointment_id}/reschedule` (rescheduleAppointment). */
  reschedule(
    appointmentId: string,
    params: RescheduleAppointmentParams,
    options?: RequestOptions,
  ): Promise<Message> {
    return this.transport.request(
      {
        operation: 'rescheduleAppointment',
        method: 'PATCH',
        path: path`/api/appointments/${appointmentId}/reschedule`,
        params: { appointment_id: appointmentId },
        body: params,
      },
      options,
    );
  }

  /**
   * `PATCH /api/appointments/{appointment_id}/cancel` (cancelAppointment). Pass `{ reason }` to
   * record why; without it hlthstack records `Cancelled by your booking partner`.
   */
  cancel(appointmentId: string, options?: RequestOptions): Promise<Message>;
  cancel(appointmentId: string, params: CancelParams, options?: RequestOptions): Promise<Message>;
  cancel(
    appointmentId: string,
    paramsOrOptions?: CancelParams | RequestOptions,
    maybeOptions?: RequestOptions,
  ): Promise<Message> {
    const [body, options] = cancelArgs(paramsOrOptions, maybeOptions);
    return this.transport.request(
      {
        operation: 'cancelAppointment',
        method: 'PATCH',
        path: path`/api/appointments/${appointmentId}/cancel`,
        params: { appointment_id: appointmentId },
        body,
      },
      options,
    );
  }

  /** `GET /api/appointments/{appointment_id}/voucher` (getAppointmentVoucher). Returns the PDF bytes. */
  getVoucher(appointmentId: string, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request(
      {
        operation: 'getAppointmentVoucher',
        method: 'GET',
        path: path`/api/appointments/${appointmentId}/voucher`,
        params: { appointment_id: appointmentId },
        responseType: 'arrayBuffer',
      },
      options,
    );
  }

  /**
   * `GET /api/appointments/{appointment_id}/reports` (getAppointmentReports). Returns
   * `{ reports }` once verified, otherwise `{ message }`.
   */
  getReports(appointmentId: string, options?: RequestOptions): Promise<AppointmentReportsResponse> {
    return this.transport.request(
      {
        operation: 'getAppointmentReports',
        method: 'GET',
        path: path`/api/appointments/${appointmentId}/reports`,
        params: { appointment_id: appointmentId },
      },
      options,
    );
  }

  /** `GET /api/appointments/{appointment_id}/lab_results` (getAppointmentLabResults). Enabled on request. */
  getLabResults(appointmentId: string, options?: RequestOptions): Promise<LabResults> {
    return this.transport.request(
      {
        operation: 'getAppointmentLabResults',
        method: 'GET',
        path: path`/api/appointments/${appointmentId}/lab_results`,
        params: { appointment_id: appointmentId },
      },
      options,
    );
  }
}

// The cancel methods take `(id, options)` as before, or `(id, { reason }, options)`.
function cancelArgs(
  paramsOrOptions: CancelParams | RequestOptions | undefined,
  maybeOptions: RequestOptions | undefined,
): [CancelParams | undefined, RequestOptions | undefined] {
  if (paramsOrOptions && 'reason' in paramsOrOptions) return [paramsOrOptions as CancelParams, maybeOptions];
  return [undefined, paramsOrOptions as RequestOptions | undefined];
}
