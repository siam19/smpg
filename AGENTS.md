# Instructions for AI Coding Agents Integrating SMPG

> You are an expert software engineer integrating **SMPG (Send Money Payment Gateway)** into an e-commerce storefront. SMPG is a self-hosted, single-owner, multi-store Cloudflare Worker gateway with embedded custom checkout UIs. Follow these golden rules strictly.

---

## The 6 Golden Rules of SMPG Integration

### 1. Create Local Order BEFORE Creating Payment Session
Always insert your store's order record into your database *before* creating the SMPG payment session. Pass your local order identifier as `external_order_id` and use it as the `idempotencyKey`:
```typescript
const order = await db.orders.create({ total: 1850, status: 'PENDING_PAYMENT' });

const payment = await smpg.payments.create(
  {
    amount: order.total,
    external_order_id: order.id,
  },
  { idempotencyKey: order.id }
);
```

### 2. Never Mark Orders as "Paid" on Client Submission
When the customer submits their Transaction ID (TrxID) in your embedded checkout UI (via `SMPGCheckout.submit` or your backend), the merchant has **NOT** verified the funds yet.
- Prepaid orders (bKash/Nagad) must be set to `AWAITING_VERIFICATION` or `PAYMENT_PENDING`.
- Display a message: *"Payment received! The seller is verifying your transaction."*
- **NEVER** set order status to `PAID` based on client-side submission responses or redirect query parameters.

### 3. Verify Webhooks on RAW Request Bodies (`x-smpg-signature`)
Webhook signatures use HMAC-SHA256 in the `x-smpg-signature` header (`t=...,v1=...`).
- Always pass the raw, unparsed string or Buffer to `smpg.webhooks.constructEvent(rawBody, signatureHeader)`.
- Never verify re-serialized JSON (e.g. `JSON.stringify(req.body)`), as key ordering will invalidate the signature.
- Reject requests with missing or invalid signatures with HTTP 400.

### 4. Ensure Idempotent Webhook Processing
Webhooks can be retried up to 5 times on network failure.
- Store processed `event.id` values or check if `order.status === 'PAID'` before executing state transitions.
- Return HTTP 200 immediately for duplicate events to acknowledge receipt.

### 5. Handle `payment.rejected`, Customer Retries, and `payment.reopened`
When a seller rejects an incorrect TrxID:
- Update the order state to `PAYMENT_REJECTED`.
- Direct the customer back to your storefront's own order/checkout page (using `event.data.external_order_id` and `event.data.id`) so they can submit a corrected TrxID via `SMPGCheckout` (up to 3 attempts).
- If the seller reopens a rejected payment in Telegram, SMPG sends `payment.reopened` — move the order back to `AWAITING_VERIFICATION`.

### 6. COD Orders are Confirmed Immediately
When a customer selects Cash on Delivery:
- SMPG transitions the payment directly to `CONFIRMED`.
- The webhook event sent is `payment.confirmed`.
- Update your local order to `CONFIRMED_COD` and proceed with fulfillment.

---

## Quick Reference Code Snippet

```typescript
import { SMPG, SMPGCheckout } from 'send-money-payment-gateway';

// Server-side client
const smpg = new SMPG(process.env.SMPG_SECRET_KEY!, {
  baseUrl: process.env.SMPG_CORE_URL!, // Your self-hosted Worker URL
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});

// Browser-safe client (for embedded checkout UI, no secret key needed)
const checkout = new SMPGCheckout({
  baseUrl: process.env.NEXT_PUBLIC_SMPG_CORE_URL!,
});

// Handling Webhook in Next.js / Node
export async function handleWebhook(rawBody: string, signature: string) {
  // Read signature from the `x-smpg-signature` header
  const event = await smpg.webhooks.constructEvent(rawBody, signature);

  switch (event.type) {
    case 'payment.paid':
      await updateOrderStatus(event.data.external_order_id, 'PAID');
      break;
    case 'payment.confirmed':
      await updateOrderStatus(event.data.external_order_id, 'CONFIRMED_COD');
      break;
    case 'payment.rejected':
      await updateOrderStatus(event.data.external_order_id, 'PAYMENT_REJECTED');
      break;
    case 'payment.reopened':
      await updateOrderStatus(event.data.external_order_id, 'AWAITING_VERIFICATION');
      break;
  }
}
```
