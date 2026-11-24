# send-money-payment-gateway

Official TypeScript/JavaScript client SDK for **Send Money Payment Gateway (SMPG)** — a self-hosted Cloudflare Worker + Telegram Bot gateway for accepting bKash Send Money, Nagad Send Money, and Cash on Delivery (COD) with zero runtime dependencies.

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

Deploy your own SMPG Core Worker (`bun run setup` in the SMPG repository), create a store in your private Telegram bot, and grab your store's `API Key`, `Webhook Secret`, and Worker `baseUrl`.

### 1. Initialize Server Client

```typescript
import { SMPG } from "send-money-payment-gateway";

const smpg = new SMPG(process.env.SMPG_API_KEY!, {
  baseUrl: process.env.SMPG_BASE_URL!, // Your self-hosted Worker URL, e.g. https://smpg-core.<subdomain>.workers.dev
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});
```

### 2. Create a Payment Session (Server-Side)

Always create your local order first and pass its ID as `external_order_id`.

```typescript
const payment = await smpg.payments.create(
  {
    amount: 1250, // Integer BDT
    method: "bkash", // Optional: "cod" | "bkash" | "nagad" (omit to let the customer choose)
    external_order_id: "ORD-1042",
    customer: {
      name: "Rafi",
      phone: "017XXXXXXXX",
    },
    success_url: "https://your-store.com/orders/ORD-1042", // Optional
    cancel_url: "https://your-store.com/cart", // Optional
    metadata: {
      cart_id: "cart_987",
    },
  },
  {
    idempotencyKey: "order_ORD-1042",
  }
);

// Pass payment.id to your storefront's embedded checkout UI
console.log(payment.id, payment.assigned_wallet);
```

### 3. Embedded Custom Checkout Box (Browser-Safe)

Use `SMPGCheckout` in your frontend (React, Next.js, Vue, vanilla HTML) to render a native checkout UI directly inside your website. It requires **no API secret key** — only your self-hosted Worker `baseUrl`.

```typescript
import { SMPGCheckout } from "send-money-payment-gateway";

// Safe for browser / client-side code (baseUrl is required)
const checkout = new SMPGCheckout({
  baseUrl: process.env.NEXT_PUBLIC_SMPG_URL!,
});
// Also supports: new SMPGCheckout(process.env.NEXT_PUBLIC_SMPG_URL!)

// 1. Fetch public session details (amount, store name, available methods, status)
const session = await checkout.getSession(paymentId);

// 2. Customer selects a payment method ("bkash" | "nagad" | "cod")
const selection = await checkout.selectMethod(paymentId, "bkash");
if (selection.assigned_wallet) {
  console.log(
    `Send ৳${session.amount} to ${selection.assigned_wallet.number} (${selection.assigned_wallet.provider})`
  );
}

// 3. Customer submits their TrxID
const result = await checkout.submit(paymentId, {
  trx_id: "9A8B7C6D5E",
  sender_number: "01711223344", // Optional
});
console.log(result.status); // "SUBMITTED"

// 4. Poll payment status while awaiting Telegram verification
const status = await checkout.getStatus(paymentId);
console.log(status.status); // "SUBMITTED" | "PAID" | "REJECTED" | ...
```

### 4. Handle Webhook Events (Next.js / Edge / Node / Hono)

Verify every incoming webhook against the **raw request body** using the `x-smpg-signature` header.

```typescript
export async function POST(req: Request) {
  const signature = req.headers.get("x-smpg-signature");
  const rawBody = await req.text();

  if (!signature) {
    return new Response("Missing x-smpg-signature header", { status: 400 });
  }

  // Verify HMAC-SHA256 signature and parse normalized Payment event
  const event = await smpg.webhooks.constructEvent(rawBody, signature);
  const orderId = event.data.external_order_id;

  switch (event.type) {
    case "payment.paid":
      // Prepaid order verified and approved via Telegram — fulfill order
      await fulfillOrder(orderId);
      break;

    case "payment.confirmed":
      // COD order confirmed — proceed to shipping
      await shipCodOrder(orderId);
      break;

    case "payment.rejected":
      // Rejected by store owner — link customer to your storefront's own retry page
      await markOrderRejected(orderId, `/orders/${orderId}`);
      break;

    case "payment.reopened":
      // Store owner reopened a previously rejected payment via Telegram
      await markOrderAwaitingVerification(orderId);
      break;
  }

  return new Response("OK", { status: 200 });
}
```

## Features

- **Zero runtime dependencies**: Built using standard `fetch` and `crypto.subtle` (Web Crypto API).
- **Self-hosted first**: Connects directly to your own Cloudflare Worker URL with no central gateway dependency.
- **Universal runtime support**: Node.js 18+, Bun, Deno, Cloudflare Workers, and Vercel Edge.
- **Dual module format**: Ships with ESM (`.js`) and CommonJS (`.cjs`) builds plus TypeScript type definitions (`.d.ts` / `.d.cts`).
