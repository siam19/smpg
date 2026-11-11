import type { WebhookEvent } from './types';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Constant-time comparison of two hex strings to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Computes HMAC-SHA256 hex string using standard Web Crypto API.
 */
async function computeHmacSha256(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VerifySignatureOptions {
  toleranceSeconds?: number;
}

/**
 * Validates the SMPG webhook signature and parses the event payload.
 *
 * @param rawBody - Raw unparsed HTTP request body string
 * @param signatureHeader - The `x-smpg-signature` header value (e.g. `t=1731330000,v1=abcdef...`)
 * @param secret - The merchant webhook secret
 * @param options - Optional verification parameters such as timestamp tolerance
 */
export async function constructEvent<T = any>(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  options?: VerifySignatureOptions
): Promise<WebhookEvent<T>> {
  if (!signatureHeader) {
    throw new WebhookVerificationError('Missing signature header');
  }
  if (!secret) {
    throw new WebhookVerificationError('Webhook secret is required for signature verification');
  }

  const parts = signatureHeader.split(',');
  let timestampStr: string | undefined;
  let signature: string | undefined;

  for (const part of parts) {
    const [key, val] = part.trim().split('=');
    if (key === 't') {
      timestampStr = val;
    } else if (key === 'v1') {
      signature = val;
    }
  }

  if (!timestampStr || !signature) {
    throw new WebhookVerificationError('Malformed signature header');
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    throw new WebhookVerificationError('Invalid timestamp in signature header');
  }

  const tolerance = options?.toleranceSeconds ?? 300;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError('Webhook timestamp out of tolerance range');
  }

  const expectedSignature = await computeHmacSha256(secret, `${timestampStr}.${rawBody}`);
  if (!timingSafeEqual(signature, expectedSignature)) {
    throw new WebhookVerificationError('Signature mismatch');
  }

  try {
    return JSON.parse(rawBody) as WebhookEvent<T>;
  } catch (err) {
    throw new WebhookVerificationError('Invalid JSON payload in webhook body');
  }
}
