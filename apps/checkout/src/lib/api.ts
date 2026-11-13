import type { CheckoutSessionData, PaymentMethod, SubmitPaymentResult } from './types';

export function getCoreBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return 'http://localhost:8787';
    }
  }
  return 'https://smpg-core.fhasan-gch.workers.dev';
}

export async function fetchCheckoutData(
  paymentId: string,
  fetchFn: typeof fetch = fetch
): Promise<CheckoutSessionData> {
  const baseUrl = getCoreBaseUrl();
  const res = await fetchFn(`${baseUrl}/c/${encodeURIComponent(paymentId)}/data`);

  if (!res.ok) {
    let errMsg = `Failed to load payment session (${res.status})`;
    try {
      const errData = (await res.json()) as any;
      if (errData?.error?.message) errMsg = errData.error.message;
    } catch {}
    throw new Error(errMsg);
  }

  return (await res.json()) as CheckoutSessionData;
}

export async function choosePaymentMethod(
  paymentId: string,
  method: PaymentMethod,
  fetchFn: typeof fetch = fetch
): Promise<{ id: string; method: PaymentMethod; status: string; assigned_wallet?: any; redirect_url?: string }> {
  const baseUrl = getCoreBaseUrl();
  const res = await fetchFn(`${baseUrl}/c/${encodeURIComponent(paymentId)}/method`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method }),
  });

  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(data?.error?.message || `Failed to set payment method (${res.status})`);
  }

  return data;
}

export async function submitPaymentDetails(
  paymentId: string,
  params: { trx_id: string; sender_number?: string; honeypot?: string },
  fetchFn: typeof fetch = fetch
): Promise<SubmitPaymentResult> {
  const baseUrl = getCoreBaseUrl();
  const res = await fetchFn(`${baseUrl}/c/${encodeURIComponent(paymentId)}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(data?.error?.message || `Failed to submit payment details (${res.status})`);
  }

  return data as SubmitPaymentResult;
}
