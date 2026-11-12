/**
 * Friendly names for the request and response types.
 *
 * Everything here is derived from `src/generated/openapi.ts`, which is generated from the
 * OpenAPI spec (`npm run generate`). Do not hand-edit shapes here; change the spec instead.
 */
import type { components, operations } from './generated/openapi.js';
import type { FileInput } from './uploads.js';

type Schemas = components['schemas'];
type OperationId = keyof operations;

type QueryOf<K extends OperationId> = NonNullable<operations[K]['parameters']['query']>;

type JsonBodyOf<K extends OperationId> = operations[K] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : operations[K] extends { requestBody?: { content: { 'application/json': infer B } } }
    ? B
    : never;

type JsonResponseOf<K extends OperationId> = operations[K]['responses'] extends {
  200: { content: { 'application/json': infer R } };
}
  ? R
  : operations[K]['responses'] extends { 202: { content: { 'application/json': infer R } } }
    ? R
    : never;

/**
 * ePharmacy GET endpoints take `customer_details[api_customer_id]` in the query string. The
 * client accepts it as `customer_details: { api_customer_id }`, the same as in JSON bodies.
 */
type WithCustomerDetails<Q> = Omit<Q, 'customer_details[api_customer_id]'> & {
  customer_details: Schemas['CustomerDetailsRef'];
};

// ------------------------------------------------------------------ shared schemas
export type AccessToken = Schemas['AccessToken'];
export type Message = Schemas['Message'];
export type Messages = Schemas['Messages'];
export type PartialResult = Schemas['PartialResult'];
export type FileLink = Schemas['FileLink'];
export type BookingAddress = Schemas['BookingAddress'];
export type BookingCustomer = Schemas['BookingCustomer'];
export type Provider = Schemas['Provider'];
export type Slot = Schemas['Slot'];
export type AppointmentStatus = Schemas['AppointmentStatus'];
export type AppointmentDetails = Schemas['AppointmentDetails'];
export type AppointmentPayment = Schemas['AppointmentPayment'];
export type LabResults = Schemas['LabResultsPayload'];
export type ConsultationCustomer = Schemas['ConsultationCustomer'];
export type ConsultationDetails = Schemas['ConsultationDetails'];
export type CustomerDetailsRef = Schemas['CustomerDetailsRef'];
export type Cart = Schemas['Cart'];
export type CartProduct = Schemas['CartProduct'];
export type PharmacyAddressInput = Schemas['PharmacyAddressInput'];
export type FulfillmentOption = Schemas['FulfillmentOption'];
export type Order = Schemas['Order'];
export type OrderItem = Schemas['OrderItem'];
export type PharmacyOrderStatus = Schemas['PharmacyOrderStatus'];
export type WalletBenefit = Schemas['WalletBenefit'];

// ------------------------------------------------------------------ health checkups
export type ListProvidersParams = QueryOf<'listProviders'>;
export type ProvidersResponse = Schemas['ProvidersResponse'];
export type ListSlotsParams = QueryOf<'listSlots'>;
export type SlotsResponse = Schemas['SlotsResponse'];
export type CreateAppointmentParams = Schemas['CreateAppointmentRequest'];
export type CreateAppointmentResponse = Schemas['CreateAppointmentResponse'];
export type GetAppointmentParams = QueryOf<'getAppointment'>;
export type BookingDetails = Schemas['BookingDetails'];
export type RescheduleAppointmentParams = Schemas['RescheduleAppointmentRequest'];
export type AppointmentReportsResponse = JsonResponseOf<'getAppointmentReports'>;

// ------------------------------------------------------------------ consultations
export type ListInclinicConsultationProvidersParams = QueryOf<'listInclinicConsultationProviders'>;
export type ListSpecialistConsultationProvidersParams =
  QueryOf<'listSpecialistConsultationProviders'>;
export type CreateInclinicConsultationParams = Schemas['CreateInclinicConsultationRequest'];
export type CreateSpecialistConsultationParams = Schemas['CreateSpecialistConsultationRequest'];
export type CreateConsultationResponse = Schemas['CreateConsultationResponse'];
export type RescheduleConsultationParams = JsonBodyOf<'rescheduleConsultation'>;
export type CancelConsultationResponse = JsonResponseOf<'cancelConsultation'>;
export type ConsultationSummaryAndPrescription =
  JsonResponseOf<'getConsultationSummaryAndPrescription'>;

/** One document for `consultations.uploadDocuments`. Sent as a `files[][name]` + `files[][value]` pair. */
export interface ConsultationDocument {
  /** Title of the document (`files[][name]`). */
  name: string;
  /** The file (`files[][value]`): PDF, JPEG or PNG. */
  file: FileInput;
}

// ------------------------------------------------------------------ ePharmacy
export type SearchMedicinesParams = QueryOf<'searchMedicines'>;
export type MedicineSearchResponse = Schemas['MedicineSearchResponse'];

/** The single customer of a digitization request (sent as `customers[][...]` form fields). */
export interface DigitizePrescriptionCustomer {
  name: string;
  /** Alphanumeric. */
  api_customer_id: string;
  /** 10 digits. */
  mobile_number: string;
  gender: 'male' | 'female' | 'non-binary';
  /** YYYY-MM-DD. */
  dob: string;
}

export interface DigitizePrescriptionParams {
  /** Exactly one customer. */
  customers: [DigitizePrescriptionCustomer];
  plan_id?: string;
  /** JPEG, PNG or PDF; each up to 10 MB. Sent as `files[]`. */
  files: FileInput[];
}
export type DigitizationAccepted = Schemas['DigitizationAccepted'];
export type DigitizationStatus = Schemas['DigitizationStatus'];

export type GetCartParams = WithCustomerDetails<QueryOf<'getCart'>>;
export type CartResponse = JsonResponseOf<'getCart'>;
/** JSON cart update (products, address, prescription URLs, fulfillment type...). */
export type UpdateCartParams = Schemas['UpdateCartRequest'];
/**
 * Multipart cart update that uploads prescription files (`prescription_files[]`, each under
 * 7 MB; PDF, PNG or JPEG). The spec defines only these fields for the multipart form.
 */
export interface UpdateCartWithFilesParams {
  customer_details: CustomerDetailsRef;
  plan_id?: string;
  prescription_files: FileInput[];
}
export type GetFulfillmentOptionsParams = WithCustomerDetails<QueryOf<'getFulfillmentOptions'>>;
export type FulfillmentOptions = Schemas['FulfillmentOptions'];
export type OrderPaymentDetailsParams = Schemas['OrderPaymentDetailsRequest'];
export type OrderPaymentDetails = Schemas['OrderPaymentDetails'];
export type CreateOrderParams = Schemas['CreateOrderRequest'];
export type CreateOrderResponse = Schemas['CreateOrderResponse'];
export type ListOrdersParams = WithCustomerDetails<QueryOf<'listOrders'>>;
export type ListOrdersResponse = JsonResponseOf<'listOrders'>;
export type GetOrderParams = WithCustomerDetails<QueryOf<'getOrder'>>;
export type GetOrderResponse = JsonResponseOf<'getOrder'>;
export type CancelOrderParams = JsonBodyOf<'cancelOrder'>;
export type CancelOrderResponse = JsonResponseOf<'cancelOrder'>;
export type ConfirmOrderParams = JsonBodyOf<'confirmOrder'>;
export type ConfirmOrderResponse = JsonResponseOf<'confirmOrder'>;

// ------------------------------------------------------------------ wallet
export type GetCustomerWalletParams = QueryOf<'getCustomerWallet'>;
export type WalletResponse = Schemas['WalletResponse'];
export type ListCustomerPlansParams = QueryOf<'listCustomerPlans'>;
export type CustomerPlansResponse = Schemas['CustomerPlansResponse'];

// ------------------------------------------------------------------ pre-registration
export type PreRegistrationAccessToken = Schemas['PreRegistrationAccessToken'];
export type PreRegistrationEmployee = Schemas['PreRegistrationEmployee'];
export type PreRegistrationDependant = Schemas['PreRegistrationDependant'];
export type PreRegistrationEmployeeUpdate = Schemas['PreRegistrationEmployeeUpdate'];
export type PreRegistrationDependantUpdate = Schemas['PreRegistrationDependantUpdate'];
export type VoluntaryPlanEntry = Schemas['VoluntaryPlanEntry'];
export type CreatePreRegistrationsParams = Schemas['CreatePreRegistrationsRequest'];
export type UpdatePreRegistrationsParams = Schemas['UpdatePreRegistrationsRequest'];
export type DeactivatePreRegistrationsParams = Schemas['DeactivatePreRegistrationsRequest'];
export type PreRegistrationAccepted = Schemas['PreRegistrationAccepted'];
export type PreRegistrationStatus = Schemas['PreRegistrationStatus'];
export type PreRegistrationSuccessRecord = Schemas['PreRegistrationSuccessRecord'];
export type PreRegistrationFailureRecord = Schemas['PreRegistrationFailureRecord'];

// ------------------------------------------------------------------ testing (staging only)
export type SimulateAppointmentStatusParams = JsonBodyOf<'simulateAppointmentStatus'>;
export type SimulateConsultationStatusParams = JsonBodyOf<'simulateConsultationStatus'>;
export type SimulateOrderStatusParams = JsonBodyOf<'simulateOrderStatus'>;
export type SimulateOrderStatusResponse = JsonResponseOf<'simulateOrderStatus'>;
