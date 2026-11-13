# send-money-payment-gateway

Official TypeScript/JavaScript client SDK for **Send Money Payment Gateway (SMPG)**. Accept bKash Send Money, Nagad Send Money, and Cash on Delivery (COD) on modern web applications with zero runtime dependencies.

## Installation

```bash
# Using bun
bun add send-money-payment-gateway

# Using npm
npm install send-money-payment-gateway

# Using pnpm
pnpm add send-money-payment-gateway
```

## Quick Start

### 1. Initialize Client

```typescript
import { SMPG } from "send-money-payment-gateway";

const smpg = new SMPG(process.env.SMPG_API_KEY!, {
  baseUrl: process.env.SMPG_BASE_URL!, // e.g. https://smpg-core.<account>.workers.dev
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});
```

### 2. Create Payment & Redirect Customer

```typescript
// Create payment session
const payment = await smpg.payments.create(
  {
    amount: 1250, // Integer BDT
    method: "bkash", // "cod" | "bkash" | "nagad" (or omit to let customer choose)
    external_order_id: "ORD-1042",
    customer: {
      name: "Rafi",
      phone: "017XXXXXXXX",
    },
    success_url: "https://your-store.com/orders/ORD-1042/thanks",
    cancel_url: "https://your-store.com/cart",
    metadata: {
      cart_id: "cart_987",
    },
  },
  {
    idempotencyKey: "order_ORD-1042",
  }
);

// Redirect the customer to hosted checkout
console.log(payment.checkout_url);
```

### 3. Custom / Embedded Checkout Box (Optional)

If you prefer building a native checkout UI directly inside your website instead of redirecting, use the browser-safe `SMPGCheckout` client:

```typescript
import { SMPGCheckout } from "send-money-payment-gateway";

// Safe for browser / client-side code - requires NO API secret!
const checkout = new SMPGCheckout(payment.id, {
  baseUrl: "https://smpg-core.your-domain.workers.dev",
});

// 1. Fetch public session details (amount, available methods, store branding)
const session = await checkout.getSession();

// 2. Customer selects a payment method (e.g. bKash)
const { wallet } = await checkout.selectMethod("bkash");
console.log(`Please send ৳${session.amount} to ${wallet.number} (${wallet.type})`);

// 3. Customer submits their TrxID
const result = await checkout.submit({ trx_id: "9A8B7C6D5E" });
console.log(result.status); // "SUBMITTED"
```

### 4. Handle Webhook Events (Next.js / Edge / Node)

```typescript
export async function POST(req: Request) {
  const signature = req.headers.get("x-smpg-signature");
  const rawBody = await req.text();

  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  // Construct and verify event
  const event = await smpg.webhooks.constructEvent(rawBody, signature);

  switch (event.type) {
    case "payment.paid":
      // Prepaid order verified and approved - fulfill order
      await fulfillOrder(event.data.external_order_id);
      break;

    case "payment.confirmed":
      // COD order confirmed - ship parcel
      await shipOrder(event.data.external_order_id);
      break;

    case "payment.rejected":
      // Rejected by seller - notify customer with event.data.retry_url
      await notifyCustomerToRetry(event.data.external_order_id, event.data.retry_url);
      break;
  }

  return new Response("OK", { status: 200 });
}
```

## Features

- **Zero runtime dependencies**: Built using standard `fetch` and `crypto.subtle` (Web Crypto API).
- **Universal runtime support**: Node.js 18+, Bun, Deno, Cloudflare Workers, and Vercel Edge.
- **Dual module format**: Ships with ESM (`.js`) and CommonJS (`.cjs`) builds plus TypeScript type definitions (`.d.ts` / `.d.cts`).
