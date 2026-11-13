# Instructions for AI Coding Agents Integrating SMPG

> You are an expert software engineer integrating **SMPG (Send Money Payment Gateway)** into an e-commerce storefront. Follow these golden rules strictly.

---

## The 6 Golden Rules of SMPG Integration

### 1. Create Local Order BEFORE Redirecting
Always insert your store's order record into your database *before* creating the SMPG payment session. Pass your local order identifier as `external_order_id`:
```typescript
const order = await db.orders.create({ total: 1850, status: 'PENDING_PAYMENT' });

const payment = await smpg.payments.create({
  amount: order.total,
  external_order_id: order.id,
  success_url: `https://mystore.com/orders/${order.id}/thanks`,
  cancel_url: `https://mystore.com/cart`,
});
```

### 2. Never Mark Orders as "Paid" on Redirect
The `success_url` indicates that the customer has submitted their Transaction ID (TrxID) or confirmed COD. The merchant has **NOT** verified the funds yet.
- Prepaid orders (bKash/Nagad) must be set to `AWAITING_VERIFICATION` or `PAYMENT_PENDING`.
- Display a message: *"Payment received! The seller is verifying your transaction."*
- **NEVER** set order status to `PAID` based on query parameters or redirects.

### 3. Verify Webhooks on RAW Request Bodies
Webhook signatures use HMAC-SHA256 (`SMPG-Signature: t=...,v1=...`).
- Always pass the raw, unparsed string or Buffer to `smpg.webhooks.constructEvent(rawBody, signatureHeader)`.
- Never verify re-serialized JSON (e.g. `JSON.stringify(req.body)`), as key ordering will invalidate the signature.
- Reject requests with missing or invalid signatures with HTTP 400.

### 4. Ensure Idempotent Webhook Processing
Webhooks can be retried up to 5 times on network failure.
- Store processed `event.id` values or check if `order.status === 'PAID'` before executing state transitions.
- Return HTTP 200 immediately for duplicate events to acknowledge receipt.

### 5. Handle `payment.rejected` and Customer Retries
When a seller rejects an incorrect TrxID:
- The webhook event `payment.rejected` includes `event.data.retry_url`.
- Update the order state to `PAYMENT_REJECTED`.
- Display the retry button or send an SMS/Email with the `retry_url` so the customer can submit their correct TrxID (up to 3 attempts).

### 6. COD Orders are Confirmed Immediately
When a customer selects Cash on Delivery:
- SMPG transitions the payment directly to `CONFIRMED`.
- The webhook event sent is `payment.confirmed`.
- Update your local order to `CONFIRMED_COD` and proceed with fulfillment.

---

## Quick Reference Code Snippet

```typescript
import { SMPG } from '@smpg/sdk';

const smpg = new SMPG(process.env.SMPG_SECRET_KEY!, {
  baseUrl: process.env.SMPG_CORE_URL!,
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});

// Handling Webhook in Next.js / Node
export async function handleWebhook(rawBody: string, signature: string) {
  const event = await smpg.webhooks.constructEvent(rawBody, signature);

  switch (event.type) {
    case 'payment.paid':
      await updateOrderStatus(event.data.external_order_id, 'PAID');
      break;
    case 'payment.confirmed':
      await updateOrderStatus(event.data.external_order_id, 'COD_CONFIRMED');
      break;
    case 'payment.rejected':
      await updateOrderStatus(event.data.external_order_id, 'PAYMENT_REJECTED', event.data.retry_url);
      break;
  }
}
```
