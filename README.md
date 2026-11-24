<p align="center">
  <img src="docs/smpg-logo.png" alt="SMPG — Send Money Payment Gateway" width="380" />
</p>

<p align="center">
  <strong>Self-hosted, single-owner, multi-store payment gateway for bKash Personal Send Money, Nagad Personal Send Money, and Cash on Delivery (COD)</strong><br />
  0% transaction fees · No corporate trade license required · Free Cloudflare Workers + D1 hosting (no credit card required)
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/send-money-payment-gateway"><img src="https://img.shields.io/npm/v/send-money-payment-gateway?color=blue" alt="NPM Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT" /></a>
  <a href="packages/sdk"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Zero Dependencies" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0+-blue" alt="TypeScript" /></a>
</p>

---

## Prerequisites

Because SMPG is **100% self-hosted** (there is no central server or shared bot), you will need:

1. **A Telegram account** — used to create your own private payments bot via `@BotFather` and approve/reject customer transactions.
2. **A Cloudflare account** — free tier is plenty (Cloudflare Workers + D1 SQLite require **no credit card**). Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
3. **Bun (v1.2+)** installed locally — install from [bun.sh](https://bun.sh).

---

## Quick Start

### Step 1: Create Your Telegram Bot with `@BotFather`

1. Open Telegram and search for **`@BotFather`** (look for the blue verified checkmark).
2. Send `/newbot`.
3. Enter a **display name** for your bot (for example: `My Store Payments`).
4. Enter a **username** ending in `bot` (for example: `mystore_payments_bot`).
5. `@BotFather` will reply with your **HTTP API Token** (looks like `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`). Copy and keep it private — you will paste it in Step 2.

*(Optional: If you want to lock the bot to your Telegram account immediately during setup, grab your numeric Telegram User ID from `@userinfobot`. Otherwise, the setup script will generate a secure one-time claim link for you.)*

---

### Step 2: Deploy SMPG Core to Your Cloudflare Account

Clone this repository and run the 1-command interactive setup CLI:

```bash
git clone https://github.com/siam19/smpg.git
cd smpg
bun install
bun run setup
```

The setup CLI walks you through everything automatically:
1. Logs into your Cloudflare account via `wrangler login` (if not already authenticated).
2. Prompts for your `@BotFather` **HTTP API Token** and validates it against Telegram.
3. Locks your bot to your Telegram account (via your `OWNER_TELEGRAM_ID` or an auto-generated one-time `/start <SETUP_TOKEN>` claim link).
4. Creates your D1 database, writes `apps/core/wrangler.toml`, and applies the schema migration remotely.
5. Deploys `apps/core` to Cloudflare Workers (`https://smpg-core.<your-subdomain>.workers.dev`).
6. Generates cryptographic `ENCRYPTION_KEY` and `TELEGRAM_WEBHOOK_SECRET` secrets and uploads them to your Worker.
7. Registers your Telegram webhook automatically and prints your **Worker URL** and **private bot link**.

---

### Step 3: Claim Your Bot & Configure Your Store in Telegram

1. Open the **private bot link** printed at the end of `bun run setup` (e.g. `https://t.me/<your_bot>?start=<setup_token>`) and tap **Start** to lock the bot to your Telegram account.
2. Create your first store (`/stores` → **Create Store**) — enter your store name to immediately receive your store credentials (shown once):
   - **Live API Key** (`smpg_live_...`)
   - **Test API Key** (`smpg_test_...`)
   - **Webhook Secret** (`whsec_...`)
3. Add your personal bKash and/or Nagad SIM numbers (`/wallets` → **Add bKash** / **Add Nagad**). Wallets are shared across all your stores by default (or can be scoped to a single store) with automatic ৳25,000/day SIM cap rotation.
4. Set your storefront's webhook URL under `/stores` → select your store → **Set Webhook** (e.g. `https://yourstore.com/api/webhooks/smpg`).

---

### Step 4: Connect SMPG to Your Website

#### 1. Install the SDK in your storefront project

```bash
# npm
npm install send-money-payment-gateway

# bun
bun add send-money-payment-gateway

# pnpm
pnpm add send-money-payment-gateway
```

#### 2. Add your environment variables

Add these to your storefront's `.env` file using the Worker URL from Step 2 and the store credentials from Step 3:

```env
# Server-side only (NEVER expose to the browser)
SMPG_CORE_URL="https://smpg-core.<your-subdomain>.workers.dev"
SMPG_SECRET_KEY="smpg_live_..."        # Use smpg_test_... while testing
SMPG_WEBHOOK_SECRET="whsec_..."

# Public (safe for browser-side SMPGCheckout)
NEXT_PUBLIC_SMPG_CORE_URL="https://smpg-core.<your-subdomain>.workers.dev"
```

#### 3. (Optional) Install the AI Coding Agent Skill

Building your storefront with an AI coding assistant (Cursor, Claude Code, Antigravity, Codex)? Install the integration skill so your agent gets the full API rules, raw-body webhook verification guidelines, and framework templates:

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
- **Single-Owner, Multi-Store**: Manage multiple storefronts from one personal Telegram bot, with shared or store-scoped personal SIM wallets and clean plain-text notifications.
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
