import { path, type RequestOptions, type Transport } from '../core.js';
import { toBlob } from '../uploads.js';
import type {
  CancelConsultationResponse,
  ConsultationDetails,
  ConsultationDocument,
  ConsultationSummaryAndPrescription,
  CreateConsultationResponse,
  CreateInclinicConsultationParams,
  CreateSpecialistConsultationParams,
  ListInclinicConsultationProvidersParams,
  ListSlotsParams,
  ListSpecialistConsultationProvidersParams,
  Message,
  ProvidersResponse,
  RescheduleConsultationParams,
  SlotsResponse,
} from '../types.js';

/** In-clinic consultations and online specialist consultations (scheduled and priority). */
export class Consultations {
  constructor(private readonly transport: Transport) {}

  /** `GET /api/consultations/inclinic_consultation/providers` (listInclinicConsultationProviders). */
  listInclinicProviders(
    params: ListInclinicConsultationProvidersParams,
    options?: RequestOptions,
  ): Promise<ProvidersResponse> {
    return this.transport.request(
      {
        operation: 'listInclinicConsultationProviders',
        method: 'GET',
        path: '/api/consultations/inclinic_consultation/providers',
        query: params,
      },
      options,
    );
  }

  /**
   * `GET /api/consultations/specialist_consultation/providers` (listSpecialistConsultationProviders).
   * Send `default_provider: true` to list priority-consultation providers.
   */
  listSpecialistProviders(
    params: ListSpecialistConsultationProvidersParams,
    options?: RequestOptions,
  ): Promise<ProvidersResponse> {
    return this.transport.request(
      {
        operation: 'listSpecialistConsultationProviders',
        method: 'GET',
        path: '/api/consultations/specialist_consultation/providers',
        query: params,
      },
      options,
    );
  }

  /**
   * `GET /api/providers/{provider_id}/{benefit_type}/slots` (listSlots), with `benefit_type`
   * `inclinic_consultation` or `specialist_consultation`. Same as `appointments.listSlots`.
   */
  listSlots(
    providerId: number,
    benefitType: 'inclinic_consultation' | 'specialist_consultation' | (string & {}),
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

  /** `POST /api/consultations/inclinic_consultation` (createInclinicConsultation). */
  createInclinic(
    params: CreateInclinicConsultationParams,
    options?: RequestOptions,
  ): Promise<CreateConsultationResponse> {
    return this.transport.request(
      {
        operation: 'createInclinicConsultation',
        method: 'POST',
        path: '/api/consultations/inclinic_consultation',
        body: params,
      },
      options,
    );
  }

  /** `POST /api/consultations/specialist_consultation` (createSpecialistConsultation). */
  createSpecialist(
    params: CreateSpecialistConsultationParams,
    options?: RequestOptions,
  ): Promise<CreateConsultationResponse> {
    return this.transport.request(
      {
        operation: 'createSpecialistConsultation',
        method: 'POST',
        path: '/api/consultations/specialist_consultation',
        body: params,
      },
      options,
    );
  }

  /** `GET /api/consultations/inclinic_consultation/{appointment_id}` (getInclinicConsultation). */
  getInclinic(appointmentId: string, options?: RequestOptions): Promise<ConsultationDetails> {
    return this.transport.request(
      {
        operation: 'getInclinicConsultation',
        method: 'GET',
        path: path`/api/consultations/inclinic_consultation/${appointmentId}`,
        params: { appointment_id: appointmentId },
      },
      options,
    );
  }

  /** `GET /api/consultations/specialist_consultation/{appointment_id}` (getSpecialistConsultation). */
  getSpecialist(appointmentId: string, options?: RequestOptions): Promise<ConsultationDetails> {
    return this.transport.request(
      {
        operation: 'getSpecialistConsultation',
        method: 'GET',
        path: path`/api/consultations/specialist_consultation/${appointmentId}`,
        params: { appointment_id: appointmentId },
      },
      options,
    );
  }

  /** `PATCH /api/consultations/{appointment_id}/reschedule` (rescheduleConsultation). Same doctor only. */
  reschedule(
    appointmentId: string,
    params: RescheduleConsultationParams,
    options?: RequestOptions,
  ): Promise<Message> {
    return this.transport.request(
      {
        operation: 'rescheduleConsultation',
        method: 'PATCH',
        path: path`/api/consultations/${appointmentId}/reschedule`,
        params: { appointment_id: appointmentId },
        body: params,
      },
      options,
    );
  }

  /** `PATCH /api/consultations/{appointment_id}/cancel` (cancelConsultation). Note the response key is `msg`. */
  cancel(appointmentId: string, options?: RequestOptions): Promise<CancelConsultationResponse> {
    return this.transport.request(
      {
        operation: 'cancelConsultation',
        method: 'PATCH',
        path: path`/api/consultations/${appointmentId}/cancel`,
        params: { appointment_id: appointmentId },
      },
      options,
    );
  }

  /**
   * `GET /api/consultations/{appointment_id}/summary_and_prescription`
   * (getConsultationSummaryAndPrescription). File links expire after a few minutes.
   */
  getSummaryAndPrescription(
    appointmentId: string,
    options?: RequestOptions,
  ): Promise<ConsultationSummaryAndPrescription> {
    return this.transport.request(
      {
        operation: 'getConsultationSummaryAndPrescription',
        method: 'GET',
        path: path`/api/consultations/${appointmentId}/summary_and_prescription`,
        params: { appointment_id: appointmentId },
      },
      options,
    );
  }

  /** `GET /api/consultations/{appointment_id}/voucher` (getConsultationVoucher). In-clinic only; returns the PDF bytes. */
  getVoucher(appointmentId: string, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request(
      {
        operation: 'getConsultationVoucher',
        method: 'GET',
        path: path`/api/consultations/${appointmentId}/voucher`,
        params: { appointment_id: appointmentId },
        responseType: 'arrayBuffer',
      },
      options,
    );
  }

  /**
   * `POST /api/consultations/{appointment_id}/upload_documents` (uploadConsultationDocuments).
   * Multipart: one `files[][name]` + `files[][value]` pair per document. PDF, JPEG or PNG.
   */
  async uploadDocuments(
    appointmentId: string,
    documents: ConsultationDocument[],
    options?: RequestOptions,
  ): Promise<Message> {
    // Validated as the wire fields (`files[][name]`, `files[][value]`), reported as `documents`.
    this.transport.validate(
      'uploadConsultationDocuments',
      {
        params: { appointment_id: appointmentId },
        form: {
          files: Array.isArray(documents)
            ? documents.map((doc) => (doc && typeof doc === 'object' ? { name: doc.name, value: doc.file } : doc))
            : documents,
        },
      },
      options,
      (p) => p.replace(/^files/, 'documents').replace(/^(documents\[\d+\])\.value/, '$1.file'),
    );
    const form = new FormData();
    for (const doc of documents) {
      const { blob, filename } = toBlob(doc.file);
      form.append('files[][name]', doc.name);
      form.append('files[][value]', blob, filename);
    }
    return this.transport.request(
      { method: 'POST', path: path`/api/consultations/${appointmentId}/upload_documents`, form },
      options,
    );
  }
}
