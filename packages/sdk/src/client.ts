import type {
  CreatePaymentOptions,
  CreatePaymentParams,
  ListPaymentsParams,
  Payment,
  SMPGOptions,
  WebhookEvent,
} from './types';
import { constructEvent, VerifySignatureOptions } from './webhooks';

export interface APIErrorResponse {
  error: {
    code: string;
    message: string;
    param?: string;
  };
}

export class SMPGError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly param?: string;

  constructor(message: string, status: number, code: string = 'api_error', param?: string) {
    super(message);
    this.name = 'SMPGError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export class SMPG {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultWebhookSecret?: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, options: SMPGOptions) {
    if (!apiKey) {
      throw new Error('API key is required');
    }
    if (!options?.baseUrl) {
      throw new Error('baseUrl is required (e.g. https://smpg-core.<account>.workers.dev)');
    }

    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.defaultWebhookSecret = options.webhookSecret;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = new Headers(init?.headers);

    headers.set('Authorization', `Bearer ${this.apiKey}`);
    if (!headers.has('Content-Type') && init?.body) {
      headers.set('Content-Type', 'application/json');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text };
      }

      if (!res.ok) {
        const errObj = (data as APIErrorResponse)?.error;
        throw new SMPGError(
          errObj?.message || `Request failed with status ${res.status}`,
          res.status,
          errObj?.code || 'request_failed',
          errObj?.param
        );
      }

      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  public readonly payments = {
    /**
     * Create a new payment session.
     */
    create: async (params: CreatePaymentParams, options?: CreatePaymentOptions): Promise<Payment> => {
      const headers: Record<string, string> = {};
      if (options?.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
      }
      return this.request<Payment>('/v1/payments', {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
    },

    /**
     * Retrieve a payment by ID.
     */
    retrieve: async (paymentId: string): Promise<Payment> => {
      return this.request<Payment>(`/v1/payments/${encodeURIComponent(paymentId)}`, {
        method: 'GET',
      });
    },

    /**
     * List payments with optional filters.
     */
    list: async (params?: ListPaymentsParams): Promise<{ data: Payment[]; has_more: boolean }> => {
      const query = new URLSearchParams();
      if (params?.external_order_id) query.set('external_order_id', params.external_order_id);
      if (params?.status) query.set('status', params.status);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);

      const qs = query.toString();
      const path = qs ? `/v1/payments?${qs}` : '/v1/payments';
      return this.request<{ data: Payment[]; has_more: boolean }>(path, {
        method: 'GET',
      });
    },

    /**
     * Cancel an unpaid payment.
     */
    cancel: async (paymentId: string): Promise<Payment> => {
      return this.request<Payment>(`/v1/payments/${encodeURIComponent(paymentId)}/cancel`, {
        method: 'POST',
      });
    },
  };

  public readonly webhooks = {
    /**
     * Verify incoming webhook signature and construct event object.
     */
    constructEvent: async <T = any>(
      rawBody: string,
      signatureHeader: string,
      secretOverride?: string,
      options?: VerifySignatureOptions
    ): Promise<WebhookEvent<T>> => {
      const secret = secretOverride ?? this.defaultWebhookSecret;
      if (!secret) {
        throw new Error('Webhook secret is required. Provide it in SMPG constructor or in constructEvent().');
      }
      return constructEvent<T>(rawBody, signatureHeader, secret, options);
    },
  };
}
