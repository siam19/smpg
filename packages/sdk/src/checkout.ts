import type {
  AssignedWallet,
  CheckoutSessionData,
  ClientCheckoutOptions,
  PaymentMethod,
  PaymentStatus,
  SMPGCheckoutOptions,
  SubmitPaymentResult,
} from './types';
import { SMPGError } from './client';

/**
 * Browser-safe client for embedded and headless checkouts.
 * Requires no API secret key.
 */
export class SMPGCheckout {
  private readonly defaultBaseUrl: string;
  private readonly defaultFetchFn?: typeof fetch;

  constructor(baseUrlOrOptions: string | SMPGCheckoutOptions) {
    const rawBaseUrl =
      typeof baseUrlOrOptions === 'string' ? baseUrlOrOptions : baseUrlOrOptions?.baseUrl;

    if (!rawBaseUrl || typeof rawBaseUrl !== 'string' || !rawBaseUrl.trim()) {
      throw new Error(
        'SMPGCheckout requires a baseUrl (e.g. https://smpg-core.<your-subdomain>.workers.dev)'
      );
    }

    this.defaultBaseUrl = rawBaseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1(?:\/payments)?$/i, '');
    this.defaultFetchFn =
      typeof baseUrlOrOptions === 'object' ? baseUrlOrOptions.fetchFn : undefined;
  }

  private getUrl(path: string, options?: ClientCheckoutOptions): string {
    const base = (options?.baseUrl || this.defaultBaseUrl)
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1(?:\/payments)?$/i, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private getFetch(options?: ClientCheckoutOptions): typeof fetch {
    return options?.fetchFn || this.defaultFetchFn || fetch;
  }

  private async parseResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new SMPGError(
        data?.error?.message || `${fallbackMessage} (${res.status})`,
        res.status,
        data?.error?.code || 'request_failed',
        data?.error?.param
      );
    }

    return data as T;
  }

  /**
   * Retrieves public checkout session data for a payment.
   */
  public async getSession(
    paymentId: string,
    options?: ClientCheckoutOptions
  ): Promise<CheckoutSessionData> {
    const fetchFn = this.getFetch(options);
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/data`, options);

    const res = await fetchFn(url);
    return this.parseResponse<CheckoutSessionData>(res, 'Failed to load checkout data');
  }

  /**
   * Selects or switches the payment method for a session.
   */
  public async selectMethod(
    paymentId: string,
    method: PaymentMethod,
    options?: ClientCheckoutOptions
  ): Promise<{
    id: string;
    method: PaymentMethod;
    status: PaymentStatus;
    assigned_wallet?: AssignedWallet | null;
    redirect_url?: string | null;
  }> {
    const fetchFn = this.getFetch(options);
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/method`, options);

    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method }),
    });

    return this.parseResponse(res, 'Failed to select method');
  }

  /**
   * Submits payment details (TrxID) for a session.
   */
  public async submit(
    paymentId: string,
    params: { trx_id: string; sender_number?: string; honeypot?: string },
    options?: ClientCheckoutOptions
  ): Promise<SubmitPaymentResult> {
    const fetchFn = this.getFetch(options);
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/submit`, options);

    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    return this.parseResponse<SubmitPaymentResult>(res, 'Failed to submit payment details');
  }

  /**
   * Retrieves current status for a payment session.
   */
  public async getStatus(
    paymentId: string,
    options?: ClientCheckoutOptions
  ): Promise<{ id: string; status: PaymentStatus; attempts: number }> {
    const fetchFn = this.getFetch(options);
    const url = this.getUrl(`/c/${encodeURIComponent(paymentId)}/status`, options);

    const res = await fetchFn(url);
    return this.parseResponse(res, 'Failed to fetch status');
  }
}
