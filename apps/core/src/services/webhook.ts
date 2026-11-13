import { and, eq, isNull, lte } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Database } from '../db';
import {
  merchants,
  payments,
  webhookDeliveries,
  type WebhookDelivery,
} from '../db/schema';
import { decryptAesGcm, generatePrefixedId } from './crypto';
import type { Env } from '../types';

/**
 * Exponential backoff retry delays in seconds:
 * Attempt 1 fail -> retry in 1 minute (60s)
 * Attempt 2 fail -> retry in 5 minutes (300s)
 * Attempt 3 fail -> retry in 30 minutes (1800s) + Alert merchant in Telegram
 * Attempt 4 fail -> retry in 2 hours (7200s)
 * Attempt 5 fail -> retry in 12 hours (43200s)
 * After 5 attempts -> marked failed (no more retries)
 */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 43200];

/**
 * Computes the HMAC-SHA256 signature for a webhook payload.
 * Signature is computed over: `${timestamp}.${rawPayload}`.
 */
export async function computeWebhookSignature(
  secret: string,
  timestamp: number,
  rawPayload: string
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`${timestamp}.${rawPayload}`)
  );
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sends a signed webhook HTTP POST request to a destination URL.
 */
export async function deliverWebhookPayload(
  url: string,
  secret: string,
  eventType: string,
  rawPayload: string,
  timeoutMs = 10000
): Promise<{ ok: boolean; status: number; error?: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureHex = await computeWebhookSignature(secret, timestamp, rawPayload);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': `t=${timestamp},v1=${signatureHex}`,
        'x-smpg-event': eventType,
        'User-Agent': 'SMPG-Webhook/1.0',
      },
      body: rawPayload,
      signal: controller.signal,
    });

    return {
      ok: res.ok,
      status: res.status,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || 'Network error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Queues a new webhook delivery record in D1.
 */
export async function queueWebhookDelivery(
  db: Database,
  paymentId: string,
  eventType: string,
  eventData: Record<string, unknown>
): Promise<WebhookDelivery> {
  const now = Math.floor(Date.now() / 1000);
  const deliveryId = generatePrefixedId('dlv');

  const payloadObj = {
    id: generatePrefixedId('evt'),
    type: eventType,
    created: now,
    data: eventData,
  };

  const newDelivery: WebhookDelivery = {
    id: deliveryId,
    paymentId,
    eventType,
    payload: JSON.stringify(payloadObj),
    attempt: 0,
    nextAttemptAt: now,
    lastStatus: null,
    deliveredAt: null,
  };

  await db.insert(webhookDeliveries).values(newDelivery);
  return newDelivery;
}

/**
 * Attempts immediate delivery for a specific webhook delivery row.
 */
export async function deliverSingleWebhook(
  db: Database,
  env: Env,
  delivery: WebhookDelivery,
  bot?: Bot<any>
): Promise<boolean> {
  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.id, delivery.paymentId))
    .get();

  if (!payment) {
    console.error(`[Webhook] Payment not found for delivery ${delivery.id}`);
    return false;
  }

  const merchant = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, payment.merchantId))
    .get();

  if (!merchant) {
    console.error(`[Webhook] Merchant not found for delivery ${delivery.id}`);
    return false;
  }

  const now = Math.floor(Date.now() / 1000);

  // If merchant has no webhook URL configured, mark delivered/skipped
  if (!merchant.webhookUrl) {
    await db
      .update(webhookDeliveries)
      .set({
        deliveredAt: now,
        nextAttemptAt: null,
        lastStatus: 200,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return true;
  }

  let secret: string;
  try {
    secret = await decryptAesGcm(merchant.webhookSecret, env.ENCRYPTION_KEY);
  } catch (decryptErr) {
    console.error(`[Webhook] Failed to decrypt webhook secret for merchant ${merchant.id}:`, decryptErr);
    return false;
  }

  const res = await deliverWebhookPayload(
    merchant.webhookUrl,
    secret,
    delivery.eventType,
    delivery.payload
  );

  const nextAttemptNum = delivery.attempt + 1;

  if (res.ok) {
    await db
      .update(webhookDeliveries)
      .set({
        attempt: nextAttemptNum,
        lastStatus: res.status,
        deliveredAt: now,
        nextAttemptAt: null,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return true;
  }

  // Delivery failed: compute next retry backoff
  const nextDelayIndex = nextAttemptNum - 1;
  const nextDelaySec =
    nextDelayIndex < RETRY_DELAYS_SECONDS.length
      ? RETRY_DELAYS_SECONDS[nextDelayIndex]
      : null;

  const nextAttemptAt = nextDelaySec !== null ? now + nextDelaySec : null;

  await db
    .update(webhookDeliveries)
    .set({
      attempt: nextAttemptNum,
      lastStatus: res.status,
      nextAttemptAt,
    })
    .where(eq(webhookDeliveries.id, delivery.id));

  // Alert merchant in Telegram if 3 consecutive failures
  if (nextAttemptNum === 3 && bot && merchant.telegramChatId) {
    try {
      const orderRef = payment.externalOrderId ? ` (${payment.externalOrderId})` : '';
      const alertMsg = [
        '⚠️ <b>Webhook Delivery Alert</b>',
        `We failed to deliver event <code>${delivery.eventType}</code> for payment <code>${payment.id}</code>${orderRef} after 3 attempts.`,
        '',
        `<b>Webhook Endpoint:</b> <code>${merchant.webhookUrl}</code>`,
        `<b>Last Response:</b> <code>${res.status || res.error || 'Connection Failed'}</code>`,
        '',
        '<i>We will continue retrying with exponential backoff. Please inspect your server logs to ensure your endpoint returns a 2xx status code.</i>',
      ].join('\n');

      await bot.api.sendMessage(merchant.telegramChatId, alertMsg, { parse_mode: 'HTML' });
    } catch (botErr) {
      console.error('[Webhook] Failed to dispatch failure alert to Telegram:', botErr);
    }
  }

  return false;
}

/**
 * Cron processor: queries pending webhook retries and executes deliveries.
 */
export async function processPendingWebhookDeliveries(
  db: Database,
  env: Env,
  bot?: Bot<any>,
  limit = 25
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const now = Math.floor(Date.now() / 1000);

  const pending = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        lte(webhookDeliveries.nextAttemptAt, now),
        isNull(webhookDeliveries.deliveredAt)
      )
    )
    .limit(limit);

  if (pending.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

  for (const delivery of pending) {
    const ok = await deliverSingleWebhook(db, env, delivery, bot);
    if (ok) {
      succeeded++;
    } else {
      failed++;
    }
  }

  return { processed: pending.length, succeeded, failed };
}
