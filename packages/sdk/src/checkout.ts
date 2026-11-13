import type {
  CheckoutSessionData,
  ClientCheckoutOptions,
  PaymentMethod,
  SubmitPaymentResult,
} from './types';
import { SMPGError } from './client';

/**
 * Browser-safe client for embedded and headless checkouts.
 * Requires no API secret key.
 */
export class SMPGCheckout {
  private readonly defaultBaseUrl: string;

  constructor(defaultBaseUrl: string = 'https://smpg-core.fhasan-gch.workers.dev') {
    this.defaultBaseUrl = defaultBaseUrl.replace(/\/+$/, '');
  }

  private getUrl(path: string, options?: ClientCheckoutOptions): string {
    const base = (options?.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * Retrieves public checkout session data for a payment.
   */
  public async getSession(
    paymentId: string,
    options?: ClientCheckoutOptions
  ): Promise<CheckoutSessionData> {
    const fetchFn = options?.fetchFn || fetch;
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/data`, options);

    const res = await fetchFn(url);
    const data = (await res.json()) as any;

    if (!res.ok) {
      throw new SMPGError(
        data?.error?.message || `Failed to load checkout data (${res.status})`,
        res.status,
        data?.error?.code || 'request_failed'
      );
    }

    return data as CheckoutSessionData;
  }

  /**
   * Selects or switches the payment method for a session.
   */
  public async selectMethod(
    paymentId: string,
    method: PaymentMethod,
    options?: ClientCheckoutOptions
  ): Promise<{ id: string; method: PaymentMethod; status: string; assigned_wallet?: any; redirect_url?: string }> {
    const fetchFn = options?.fetchFn || fetch;
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/method`, options);

    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method }),
    });

    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new SMPGError(
        data?.error?.message || `Failed to select method (${res.status})`,
        res.status,
        data?.error?.code || 'request_failed'
      );
    }

    return data;
  }

  /**
   * Submits payment details (TrxID) for a session.
   */
  public async submit(
    paymentId: string,
    params: { trx_id: string; sender_number?: string; honeypot?: string },
    options?: ClientCheckoutOptions
  ): Promise<SubmitPaymentResult> {
    const fetchFn = options?.fetchFn || fetch;
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/submit`, options);

    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new SMPGError(
        data?.error?.message || `Failed to submit payment details (${res.status})`,
        res.status,
        data?.error?.code || 'request_failed'
      );
    }

    return data as SubmitPaymentResult;
  }

  /**
   * Retrieves current status for a payment session.
   */
  public async getStatus(
    paymentId: string,
    options?: ClientCheckoutOptions
  ): Promise<{ id: string; status: string; attempts: number }> {
    const fetchFn = options?.fetchFn || fetch;
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/status`, options);

    const res = await fetchFn(url);
    const data = (await res.json()) as any;

    if (!res.ok) {
      throw new SMPGError(
        data?.error?.message || `Failed to fetch status (${res.status})`,
        res.status,
        data?.error?.code || 'request_failed'
      );
    }

    return data;
  }
}
