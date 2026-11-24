# SMPG (Send Money Payment Gateway)

Self-hosted, single-owner, multi-store payment gateway for **bKash Personal Send Money**, **Nagad Personal Send Money**, and **Cash on Delivery (COD)** on any e-commerce storefront — with **0% transaction fees**, **no corporate trade license required**, and **free Cloudflare Workers + D1 hosting (no credit card required)**.

[![NPM Version](https://img.shields.io/npm/v/send-money-payment-gateway?color=blue)](https://www.npmjs.com/package/send-money-payment-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](packages/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org)

---

## Quick Start

### 1. Self-Host SMPG Core (1 Command)

Deploy your own private SMPG Worker + D1 database and connect your own Telegram bot:

```bash
git clone https://github.com/siam19/smpg.git
cd smpg
bun install
bun run setup
```

The interactive setup CLI walks you through:
1. Checking Cloudflare Wrangler login (`bunx wrangler login`).
2. Creating a private Telegram bot via `@BotFather` and validating the token.
3. Locking the bot to your Telegram account (`OWNER_TELEGRAM_ID` or a one-time `/start <SETUP_TOKEN>` claim link).
4. Provisioning a D1 database, writing `apps/core/wrangler.toml`, and applying migrations.
5. Generating `ENCRYPTION_KEY` and `TELEGRAM_WEBHOOK_SECRET` and uploading all Worker secrets.
6. Deploying `apps/core` and registering your Telegram webhook automatically.

Once deployed, open your private Telegram bot link:
- Create one or more stores (`/stores`) — each store gets its own `smpg_live_...` / `smpg_test_...` API keys and webhook secret.
- Add your personal bKash and Nagad numbers (`/wallets`) — shared across all stores by default (or scoped to a single store) with automatic daily ৳25,000 SIM cap rotation.
- Configure each store's webhook URL (e.g. `https://mystore.com/api/webhooks/smpg`).

### 2. Install the SDK in Your Storefront

```bash
# npm
npm install send-money-payment-gateway

# bun
bun add send-money-payment-gateway

# pnpm
pnpm add send-money-payment-gateway
```

### 3. Install the AI Coding Agent Skill

When building with AI coding assistants (Cursor, Claude Code, Antigravity, Codex), install the integration skill for full guidelines, validation rules, and multi-framework templates:

```bash
npx skills add siam19/smpg --skill smpg-integration
```

---

## How SMPG Works

SMPG is designed for **embedded custom checkout UIs** inside your own storefront — no separate checkout worker or external redirect required.

```text
+----------+              +------------+             +-----------+          +-------------------+
| Customer |              | Storefront |             | SMPG Core |          |  Owner Telegram   |
+----+-----+              +-----+------+             +-----+-----+          +---------+---------+
     |                          |                          |                          |
     |--- 1. Place Order ------>|                          |                          |
     |    (total: BDT 1,850)    |--- 2. Create Payment --->|                          |
     |                          |    (POST /v1/payments)   |                          |
     |                          |<-- Return payment.id ----|                          |
     |<-- 3. Embedded Box ------|                          |                          |
     |    (pick bKash/Nagad/COD)|                          |                          |
     |                          |                          |                          |
     |--- 4. Send Money via App +------------------------->|                          |
     |    & submit TrxID        |   (via SMPGCheckout)     |--- 5. Payment Alert ---->|
     |                          |                          |    [Store Name] + TrxID  |
     |                          |                          |                          |
     |                          |                          |<-- 6. Tap "Approve" -----|
     |                          |                          |    (or reply "ok")       |
     |                          |                          |    [90s Undo Window]     |
     |                          |                          |           |              |
     |                          |<-- 7. Signed Webhook ----|<----------+              |
     |                          |    (x-smpg-signature)    |                          |
     |                          |                          |                          |
     |<-- 8. Fulfill Order -----|                          |                          |
```

### Key Principles
- **Self-Hosted & Private**: You own the Worker, D1 database, and Telegram bot. Zero central servers, zero shared merchant data, zero R2 bucket requirement.
- **Single-Owner, Multi-Store**: Manage multiple storefronts from one personal Telegram bot, with shared or store-scoped personal SIM wallets and clean plain-text notifications (no emojis).
- **Dynamic SIM Rotation**: Outgoing payments are balanced across your personal bKash/Nagad numbers so each SIM stays below its daily ৳25,000 cap across all stores.
- **90-Second Undo Window**: Any accidental Approve/Reject tap in Telegram can be undone within 90 seconds before the state finalizes and webhooks fire.
- **Signed Webhook Fulfillment**: Your storefront only fulfills orders when a verified HMAC-SHA256 webhook (`x-smpg-signature`) arrives.

---

## Integration Examples

### 1. Server-Side: Create Payment Session
```typescript
import { SMPG } from 'send-money-payment-gateway';

const smpg = new SMPG(process.env.SMPG_SECRET_KEY!, {
  baseUrl: process.env.SMPG_CORE_URL!, // Your deployed Worker URL, e.g. https://smpg-core.<subdomain>.workers.dev
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});

// 1. Create order in your database first with PENDING_PAYMENT status
const order = await db.orders.create({ total: 1850, status: 'PENDING_PAYMENT' });

// 2. Create SMPG payment session passing your local order ID
const payment = await smpg.payments.create(
  {
    amount: order.total,
    external_order_id: order.id,
    customer: { name: 'Customer Name', phone: '017XXXXXXXX' },
  },
  { idempotencyKey: order.id }
);

// Return payment.id to your storefront's embedded checkout UI
return { orderId: order.id, paymentId: payment.id };
```

### 2. Client-Side: Embedded Custom Checkout Box
Use `SMPGCheckout` directly in your storefront frontend (browser-safe, requires no secret API key):

```typescript
import { SMPGCheckout } from 'send-money-payment-gateway';

const checkout = new SMPGCheckout({
  baseUrl: process.env.NEXT_PUBLIC_SMPG_CORE_URL!, // Required: your deployed Worker URL
});

// 1. Get session details (amount, available methods, store name)
const session = await checkout.getSession(paymentId);

// 2. Customer selects a method ('bkash' | 'nagad' | 'cod')
const { assigned_wallet } = await checkout.selectMethod(paymentId, 'bkash');
console.log(`Send BDT ${session.amount} to ${assigned_wallet.number}`);

// 3. Customer submits TrxID
const result = await checkout.submit(paymentId, { trx_id: '9A8B7C6D5E' });
console.log(result.status); // "SUBMITTED"
```

See [examples/react](examples/react) for a ready-to-use React/Next.js checkout component and [examples/storefront](examples/storefront) for a complete Hono storefront with embedded checkout and webhook handling.

### 3. Server-Side: Webhook Verification (Next.js / Node)
```typescript
// app/api/webhooks/smpg/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { smpg } from '@/lib/smpg';

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-smpg-signature');
  const rawBody = await req.text(); // Raw unparsed body required for HMAC

  try {
    const event = await smpg.webhooks.constructEvent(rawBody, signature!);

    if (event.type === 'payment.paid') {
      // Verified prepaid transaction: mark order PAID
      await fulfillOrder(event.data.external_order_id);
    } else if (event.type === 'payment.confirmed') {
      // Confirmed Cash on Delivery: ship order
      await shipOrder(event.data.external_order_id);
    } else if (event.type === 'payment.rejected') {
      // Rejected TrxID: notify customer to retry on your order page
      await notifyCustomerRetry(
        event.data.external_order_id,
        `https://yourstore.com/orders/${event.data.external_order_id}`
      );
    } else if (event.type === 'payment.reopened') {
      // Merchant reopened a rejected payment: move back to awaiting verification
      await markOrderAwaitingVerification(event.data.external_order_id);
    }

    return NextResponse.json({ received: true });
  } catch (err: any) {
    return new NextResponse(`Webhook error: ${err.message}`, { status: 400 });
  }
}
```

---

## Monorepo Structure

```text
smpg/
├── apps/
│   └── core/           # Cloudflare Worker (REST API, D1 SQLite, Telegram Bot, Cron)
├── packages/
│   └── sdk/            # send-money-payment-gateway NPM package (ESM + CJS + Types)
├── examples/
│   ├── storefront/     # Reference Hono storefront (embedded checkout + webhooks + tests)
│   └── react/          # Drop-in React/Next.js embedded checkout component
├── scripts/
│   └── setup.ts        # 1-command interactive self-hosted setup & deploy CLI
├── skills/
│   └── smpg-integration/ # AI coding agent skill (SKILL.md)
└── docs/               # OpenAPI 3.1 spec, llms.txt, architecture plan, and sprint logs
```

---

## Local Development

### Prerequisites
- [Bun](https://bun.sh) (v1.2+)
- [Cloudflare Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

```bash
# 1. Install dependencies
bun install

# 2. Run local database migrations
cd apps/core && bun run d1:migrate:local && cd ../..

# 3. Build SDK packages
bun run build

# 4. Run type checks
bun run typecheck

# 5. Run full test suite
bun test
```

---

## License

[MIT](LICENSE) © SMPG Contributors
