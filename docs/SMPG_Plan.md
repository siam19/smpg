# SMPG: Send Money Payment Gateway: Final Plan (v3)

> Audience: the maintainer **and coding agents**. Sections marked 🤖 are written to be pasted into an agent's context so it can add SMPG to an e-commerce site with minimal back-and-forth.

---

## 0. Decisions log

| Topic | Decision |
|---|---|
| Payment methods | Cash on Delivery (COD), bKash Send Money, Nagad Send Money |
| Customer experience | **Optimistic and asynchronous.** After the customer submits a TrxID/TxnID they immediately see a thank-you page and return to the store. Verification happens later (minutes to hours). Nobody waits on a "processing" screen. |
| Undo window | **90 seconds** for merchant decisions; `/reopen` ships in v1 |
| Language | English only |
| Wallet numbers | Merchants can add **multiple bKash and Nagad numbers**, rotated automatically (each account can receive at most ~৳25,000/day) |
| COD advance payment | Deferred (not v1); schema hook kept (`parent_payment_id`) |
| Business model | None. Open source, **self-deploy** on Cloudflare Workers |
| Domain | None. Uses the `*.workers.dev` subdomain; every URL is derived from one configurable `PUBLIC_BASE_URL` |
| Bot | Each deployer creates their own bot, suggested name **"SMPG Payments Bot"** |
| Couriers | Support **Steadfast, Pathao and Carrybee** via **webhooks only**; merchant pastes our webhook URL + secret into the courier's console; we never store courier API credentials |
| Shopify / WordPress | Brief plugin notes only (section 16) |
| Regulation | Out of scope for this plan |

---

## 1. Goal

Let any small merchant in Bangladesh accept **COD**, **bKash Send Money**, and **Nagad Send Money** on a custom website with no trade license, no corporate bank account and no dashboard. Merchants run everything from Telegram. Developers (and their coding agents) integrate with a tiny SDK and a hosted checkout page in minutes.

### Design principles
1. **One payment object, three methods.** Same API, states, webhooks and SDK calls; only `method` differs.
2. **Async by default.** Customers are never blocked on a human. The storefront owns the "payment is being verified" experience; SMPG tells it when the outcome changes.
3. **Agent-first DX.** Few concepts, predictable names, copy-pasteable recipes, a test mode, machine-readable docs (OpenAPI + `llms.txt`).
4. **Zero-dependency, edge-native.** Cloudflare Worker + D1 core. The SDK uses only `fetch` and Web Crypto, so it runs on Workers, Vercel (Node and Edge), Deno and Bun.
5. **Human-in-the-loop first, automation later.** Telegram approval ships first; SMS auto-approval plugs into the same state machine.
6. **Dashboard-less and self-hosted.** The Telegram bot is the merchant UI; anyone can deploy their own instance.

### Non-goals (v1)
Card payments, automatic refunds, multi-currency (BDT only), Bangla UI, COD advance payments, a web dashboard.

---

## 2. System overview

```
 Customer ──► Merchant site (Next.js / SvelteKit / Workers / any)
                 │  smpg.payments.create()               ▲ signed webhooks
                 ▼                                       │
          ┌──────────────── SMPG Core (Cloudflare Worker + D1 + R2) ────────────────┐
          │ REST API │ Hosted Checkout │ Telegram webhook │ Courier hooks │ Webhook out │
          └────┬─────────────┬──────────────────┬─────────────────┬───────────────────┘
               │             │                  │                 │
        Customer browser   R2 (logos)   Merchant on Telegram   Steadfast / Pathao / Carrybee
                                        [Approve] [Reject] [Undo]   (webhook → us)
                                                ▲
                            (Tier 2, later)  Android SMS reader ──► /v1/sms-events
```

### Components (monorepo)
| Package | Purpose |
|---|---|
| `apps/core` | Worker: REST API, hosted checkout (server-rendered HTML + tiny JS), Telegram webhook, courier webhooks, webhook dispatcher, cron |
| `packages/sdk` | NPM `send-money-payment-gateway`: typed client + webhook verification |
| `packages/couriers` | Courier webhook adapters (Steadfast, Pathao, Carrybee) |
| `apps/android-sms` | (Tier 2) SMS companion app |
| `docs/` | `openapi.yaml`, `llms.txt`, agent recipes, deploy guide |
| `examples/` | Minimal Next.js (Vercel), SvelteKit and Workers storefronts |

---

## 3. Customer experience (async model)

1. Customer picks a method on the merchant's site (or on the hosted checkout).
2. **COD:** immediate confirmation, redirected to `success_url`.
3. **bKash/Nagad:** the hosted checkout shows the assigned wallet number, the exact `৳` amount (copy buttons) and a form for sender number + TrxID (label "TxnID" for Nagad). On submit the customer instantly sees **"Thank you! We received your payment details. The seller will verify them shortly."** and is redirected to `success_url?payment_id=…&status=submitted` after ~3 seconds.
4. The merchant verifies in their wallet app and taps Approve/Reject in Telegram **whenever they get to it**.
5. The storefront learns the outcome from a webhook (`payment.paid` / `payment.rejected`) and notifies the customer (email/SMS/order page). SMPG never makes the customer wait.
6. Re-opening `checkout_url` later always shows the current state: *Verifying*, *Paid*, or *Rejected* (with a resubmit form).

Implications baked into the design:
- `success_url` means "customer finished their part", **not** "paid". Storefronts must never fulfil prepaid orders from it.
- Verification can take hours, so `SUBMITTED` payments live long (72 h by default) and merchants get reminders.
- A rejection arrives after the customer has already left, so the webhook carries a `retry_url`, and the storefront should tell the customer.

---

## 4. Payment methods

| | COD | bKash | Nagad |
|---|---|---|---|
| Customer action | Places order, pays courier | Sends money to the assigned number, submits sender number + TrxID | Same, with "TxnID" label |
| Merchant action | Confirms order; delivery outcome via courier webhook or manual tap | Verifies in wallet app, taps Approve/Reject | Same as bKash |
| Needs transaction ID | No | Yes | Yes |
| Final success state | `PAID` when courier reports delivered (or merchant taps Collected) | `PAID` after Approve | `PAID` after Approve |

A merchant enables any subset of methods. Checkout only shows enabled methods that currently have capacity (see wallets).

### 4.1 TrxID / TxnID
bKash calls it **TrxID**, Nagad calls it **TxnID**; they are the same concept. API, DB and SDK use one field, `trx_id`. The checkout page and Telegram cards use the provider's label. Normalise before validating (trim, strip inner spaces, uppercase). Format rules (length/charset) are per-provider config, deliberately loose at first and tightened once we have real samples.

### 4.2 Wallet rotation (multiple numbers per provider)
Each bKash/Nagad account can receive only about ৳25,000 per day, so merchants add several numbers and SMPG spreads payments across them.

- Table `merchant_wallets` (section 6). Each wallet has `provider`, `number`, `label`, `daily_limit` (default 25000), `priority`, `active`.
- **Assignment** happens when the customer chooses bKash/Nagad and is sticky for that payment (`payments.wallet_id`). The checkout page and the Telegram card show the assigned number (and label).
- **Algorithm (default `balanced`):** among active wallets of that provider where `reserved_today + amount ≤ daily_limit`, pick the one with the lowest `reserved_today` (tie → lowest `priority` number). Optional `fill_first` strategy: pick the first by priority that still has room.
- `reserved_today` = sum of `amount` of that wallet's payments in `CREATED`, `SUBMITTED` or `PAID` whose `created_at` falls on today's date in **Asia/Dhaka**. Expired/cancelled/rejected payments release their reservation. This is an approximation (money counts on the day it was sent); merchants can lower `daily_limit` for safety.
- The cap is soft: two simultaneous assignments can overshoot slightly. Acceptable.
- If no wallet has room, that method is hidden at checkout and the merchant gets a Telegram alert. At 80% of a wallet's limit the merchant gets a heads-up.

### 4.3 COD specifics
- Payment is created with `method: "cod"` and an optional `customer_phone`.
- Merchant receives a Telegram card with **[Confirm]** / **[Cancel]** (both go through the Undo window).
- Delivery outcome (**Collected/Returned**) comes from the courier webhook (section 5) or, if no courier is linked, from manual **[Mark Collected]** / **[Returned]** buttons.
- Deferred to later: **COD advance payment** (require a small bKash/Nagad advance, linked via `parent_payment_id`). Not in v1, but the schema leaves room for it.

---

## 5. Courier webhooks (COD delivery status)

No courier offers a public unauthenticated tracking API, and querying their APIs requires saving merchant credentials. We avoid that entirely: **all three couriers can push webhooks**. The merchant enters our webhook URL + a secret in the courier's admin console, and the courier notifies us on each event (created, in transit, delivered, returned, …).

### Setup (per merchant, per courier, via Telegram)
```
/courier steadfast      → bot replies with:
   Webhook URL:  https://<worker>.workers.dev/v1/courier-hooks/steadfast/<merchant_token>
   Secret/Token: <generated>
   Paste both into the Steadfast webhook settings.
```
Same for `/courier pathao` and `/courier carrybee`. `/courier` lists integrations and `/courier steadfast rotate` regenerates the secret. We store only the generated webhook secret (encrypted), never the merchant's courier API key/secret.

### Adapter interface (`packages/couriers`, one file per courier)
```ts
interface CourierAdapter {
  id: "steadfast" | "pathao" | "carrybee";
  // verify the provider's signature/token/header, then normalise
  parseWebhook(req: Request, secret: string): Promise<CourierUpdate | null>;
}
type CourierUpdate = {
  courier: string;
  parcelRef: string;          // courier's own parcel/consignment id
  merchantOrderRef: string;   // the reference the merchant sent when booking the parcel
  status: "created" | "in_transit" | "delivered" | "returned" | "cancelled" | "unknown";
  rawStatus: string;
  raw: unknown;
};
```
The exact verification header/format and event names are provider-specific; each adapter is built against that provider's webhook docs (milestone M7), with recorded fixtures as tests. Unknown event names map to `unknown` and are stored, never dropped.

### Linking parcels to payments
When the merchant (or their storefront) books a parcel, the courier's **merchant order reference** must equal the payment's `external_order_id` (or the payment `id`). The webhook handler looks the payment up by `(merchant_id, external_order_id)`.

### Effects
| Courier status | Payment effect |
|---|---|
| `created`, `in_transit`, `unknown` | Store `courier`, `courier_ref`, `courier_status`; emit `payment.courier_updated` |
| `delivered` | COD payment → `PAID` (cash collected) |
| `returned`, `cancelled` | COD payment → `CANCELLED` (reason `returned`/`courier_cancelled`) |

- Courier-driven transitions are **final immediately** (no Undo window, since no human tapped anything) and announced in Telegram as a read-only receipt.
- Each event is deduplicated (`courier_events` table, unique on courier + parcel + raw status + timestamp) so provider retries are harmless.
- "Delivered" means the courier collected the cash. Payout from courier to merchant is between them and is not tracked by SMPG.
- Webhooks for a payment that is not COD, or not found, are stored and ignored (always answered `2xx` so the courier doesn't retry forever).

---

## 6. Payment state machine

```
 bKash / Nagad
 CREATED ──customer submits──► SUBMITTED ──Approve──► PAID
    │                              │ └────Reject────► REJECTED ──customer resubmits (≤3)──► SUBMITTED
    │                              │                      └────/reopen (merchant)────────► SUBMITTED
    │                              └──72 h without decision──► EXPIRED
    ├──60 min without submission──► EXPIRED (late submission still accepted for 24 h)
    └──cancel──► CANCELLED

 COD
 CREATED ──Confirm──► CONFIRMED ──delivered (courier/manual)──► PAID
    │                     └──returned/cancelled──► CANCELLED
    └──Cancel──► CANCELLED
```

Rules:
- Transitions are **atomic and idempotent**: `UPDATE payments SET status=? WHERE id=? AND status IN (allowed_from)`; if 0 rows change, return the current state rather than an error.
- `PAID` and `CANCELLED` are terminal. `REJECTED` and `EXPIRED` are closed but can be reopened under the conditions above.
- **Late submission:** if a customer sends money but submits the TrxID after the 60-minute `CREATED` window, the page still accepts it for 24 h; the payment goes to `SUBMITTED` and the Telegram card is flagged `⏰ submitted late`.
- **Resubmission:** after a rejection the customer may submit a different TrxID up to 3 times. Every submitted TrxID is recorded and **stays burned** (it can never be reused).
- **Reminders:** a `SUBMITTED` payment pings the merchant at 1 h, 6 h and 24 h, and warns before expiry.
- Every transition writes a `payment_events` row (audit trail).
- **Decision grace window (Undo):** a merchant's Approve / Reject / Confirm / Cancel is *recorded* immediately but *finalised* only after **90 seconds** (`UNDO_WINDOW_SECONDS`). During the window the payment keeps its current status with `pending_decision` set and **no webhook fires**. Undo clears `pending_decision`. When the window ends the transition and webhook happen and Undo disappears. Finalisation is lazy (any read finalises a due decision) plus a 1-minute cron backstop. Because customers aren't watching in real time, the window is invisible to them.
- `/reopen` (v1): the merchant can reopen a `REJECTED` payment for up to 7 days after rejection, **only if the customer hasn't submitted a newer TrxID**. It returns to `SUBMITTED` and emits `payment.reopened`, which supersedes the earlier `payment.rejected`.

---

## 7. Data model (D1)

```sql
CREATE TABLE merchants (
  id                TEXT PRIMARY KEY,            -- mrc_xxx
  telegram_chat_id  INTEGER NOT NULL UNIQUE,
  store_name        TEXT,
  logo_key          TEXT,                         -- R2 object key
  brand_color       TEXT,
  cod_enabled       INTEGER NOT NULL DEFAULT 1,
  rotation_strategy TEXT NOT NULL DEFAULT 'balanced',   -- balanced | fill_first
  webhook_url       TEXT,
  webhook_secret    TEXT NOT NULL,                -- encrypted at rest (AES-GCM, key in Worker secret)
  test_mode         INTEGER NOT NULL DEFAULT 1,
  paused            INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE merchant_wallets (
  id           TEXT PRIMARY KEY,                  -- wal_xxx
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  provider     TEXT NOT NULL CHECK (provider IN ('bkash','nagad')),
  number       TEXT NOT NULL,
  label        TEXT,
  daily_limit  INTEGER NOT NULL DEFAULT 25000,    -- BDT
  priority     INTEGER NOT NULL DEFAULT 100,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  UNIQUE (merchant_id, provider, number)
);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  key_hash     TEXT NOT NULL UNIQUE,              -- SHA-256 of key
  prefix       TEXT NOT NULL,                     -- e.g. smpg_live_ab12 (display only)
  mode         TEXT NOT NULL CHECK (mode IN ('test','live')),
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE payments (
  id                 TEXT PRIMARY KEY,            -- pay_xxx
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  mode               TEXT NOT NULL,               -- test | live
  external_order_id  TEXT,                        -- merchant's own order id
  method             TEXT NOT NULL CHECK (method IN ('cod','bkash','nagad')),
  wallet_id          TEXT REFERENCES merchant_wallets(id),
  amount             INTEGER NOT NULL,            -- BDT, whole taka
  status             TEXT NOT NULL,
  trx_id             TEXT,                        -- latest submitted TrxID/TxnID
  sender_number      TEXT,
  customer_name      TEXT,
  customer_phone     TEXT,
  parent_payment_id  TEXT REFERENCES payments(id),-- reserved for future COD advance
  verification_method TEXT,                       -- telegram | sms | courier
  courier            TEXT, courier_ref TEXT, courier_status TEXT,
  success_url        TEXT NOT NULL,
  cancel_url         TEXT,
  metadata           TEXT,                        -- JSON, ≤ 2 KB
  idempotency_key    TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  pending_decision   TEXT,                        -- approve | reject | confirm | cancel (during Undo window)
  decision_actor     TEXT,                        -- telegram:@user
  decision_effective_at INTEGER,
  late_submission    INTEGER NOT NULL DEFAULT 0,
  expires_at         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_idem ON payments(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_pay_merchant ON payments(merchant_id, created_at DESC);
CREATE INDEX ix_pay_order ON payments(merchant_id, external_order_id);
CREATE INDEX ix_pay_wallet_day ON payments(wallet_id, created_at);

-- Every TrxID ever submitted; burned forever in live mode.
CREATE TABLE trx_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  method        TEXT NOT NULL,
  trx_id        TEXT NOT NULL,
  sender_number TEXT,
  outcome       TEXT,                             -- pending | approved | rejected
  mode          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_trx ON trx_submissions(method, trx_id) WHERE mode='live';

CREATE TABLE payment_events (        -- audit trail
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor       TEXT NOT NULL,        -- customer | telegram:@user | sms | courier:steadfast | system | api
  note        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE courier_integrations (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  courier       TEXT NOT NULL CHECK (courier IN ('steadfast','pathao','carrybee')),
  url_token     TEXT NOT NULL UNIQUE,             -- path token in the webhook URL
  webhook_secret TEXT NOT NULL,                   -- encrypted; the ONLY courier credential we store
  active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (merchant_id, courier)
);

CREATE TABLE courier_events (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  courier     TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  payload     TEXT NOT NULL,
  payment_id  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status   INTEGER,
  delivered_at  INTEGER
);
```

---

## 8. REST API (v1)

Base URL: `PUBLIC_BASE_URL/v1` (e.g. `https://smpg-core.<account>.workers.dev/v1`) · Auth: `Authorization: Bearer smpg_live_…` or `smpg_test_…` · JSON bodies · amounts are integer BDT.

### `POST /v1/payments`
Create a payment. Supports `Idempotency-Key`.
```json
{
  "amount": 1250,
  "method": "bkash",                       // "cod" | "bkash" | "nagad"; omit to let the customer choose on hosted checkout
  "external_order_id": "ORD-1042",
  "customer": { "name": "Rafi", "phone": "01XXXXXXXXX" },
  "success_url": "https://shop.example/orders/ORD-1042/thanks",
  "cancel_url": "https://shop.example/cart",
  "metadata": { "cart_id": "c_9" }
}
```
Response `201`:
```json
{ "id": "pay_8f2k", "status": "CREATED", "amount": 1250, "method": "bkash",
  "checkout_url": "https://smpg-core.<account>.workers.dev/c/pay_8f2k",
  "expires_at": "2026-11-11T12:30:00Z" }
```
Redirect the customer to `checkout_url`.

### Other endpoints
- `GET /v1/payments/:id`: full payment (includes `status`, `courier_status`, `pending_decision`).
- `GET /v1/payments?external_order_id=…&status=…&limit=…&cursor=…`
- `POST /v1/payments/:id/cancel`: from `CREATED` / `CONFIRMED`.
- `POST /v1/courier-hooks/:courier/:url_token`: courier webhook receiver (section 5).

### Customer-facing (hosted checkout; no API key, payment id is the capability)
- `GET /c/:id`: checkout page (state-aware)
- `POST /c/:id/method`: choose method; assigns a wallet for bKash/Nagad
- `POST /c/:id/submit`: `{ trx_id, sender_number }`
- `GET /c/:id/status`: `{status}` for the thank-you/order page (cacheable ~5 s)

### Errors
```json
{ "error": { "code": "trx_id_already_used", "message": "…", "param": "trx_id" } }
```
Codes: `invalid_request`, `unauthorized`, `method_not_enabled`, `no_wallet_available`, `amount_out_of_range`, `trx_id_already_used`, `trx_id_invalid_format`, `too_many_attempts`, `payment_expired`, `invalid_state`, `rate_limited`.

### Validation
- `trx_id`: see 4.1. `sender_number`: `^01[3-9]\d{8}$`.
- Rate limit: 10 submissions per payment; 60 requests/min/IP on customer endpoints.

---

## 9. Telegram bot (merchant UI)

Suggested bot name: **SMPG Payments Bot**. English only.

### Commands
| Command | Behaviour |
|---|---|
| `/start` | Creates merchant, generates test + live API keys and webhook secret, replies with a short guide |
| `/add_bkash 01XXXXXXXXX [label]` | Adds a bKash wallet |
| `/add_nagad 01XXXXXXXXX [label]` | Adds a Nagad wallet |
| `/wallets` | Lists wallets with today's usage vs limit, active/paused |
| `/wallet_limit <label or number> <amount>` | Sets a wallet's daily limit |
| `/wallet_pause`, `/wallet_resume`, `/wallet_remove <label or number>` | Manage a wallet |
| `/rotation balanced\|fill_first` | Wallet rotation strategy |
| `/cod on\|off` | Enable/disable COD |
| `/courier steadfast\|pathao\|carrybee` | Generate webhook URL + secret for a courier (section 5) |
| `/store_name My Shop`, `/logo`, `/brand_color #hex` | Branding |
| `/webhook https://…` | Set webhook URL; bot sends a test ping |
| `/keys` | Show key prefixes; `/keys rotate live` rotates (shown once) |
| `/mode test\|live` | Which mode notifications/approvals apply to |
| `/payments` | Last 10 payments with status |
| `/reopen <payment_id>` | Reopen a rejected payment (section 6 rules) |
| `/pause`, `/resume` | Kill switch for new payments |
| `/team add @username` | Co-approvers (or add the bot to a group) |
| `/help` | Command list |

### Notification cards
**bKash/Nagad submitted:**
```
💸 bKash payment · ORD-1042
Amount: ৳1,250
Sent to: 017XXXXXXXX (bKash-B)
TrxID: 9K3L2M1ABC
From: 01712345678
Check this TrxID, amount and sender in your bKash app before approving.
[ ✅ Approve ] [ ❌ Reject ]
```
Nagad cards say `TxnID`. Late submissions add `⏰ submitted late`.
**COD:** `📦 COD order ORD-1042 · ৳1,250 · Rafi 017… [ ✅ Confirm ] [ ❌ Cancel ]`. After a courier is linked, later updates arrive as read-only lines (`🚚 In transit`, `✅ Delivered, cash collected`). Without a courier: `[ 💵 Mark Collected ] [ ↩ Returned ]`.

### Callback handling
- `callback_data` = `v1:<action>:<payment_id>:<nonce>`; verify the chat is the payment's merchant chat (or an authorised co-approver).
- Run the atomic update first (set `pending_decision` if still undecided), **then** edit the message, so double-taps are impossible. If 0 rows changed, just refresh the card to the current state.
- **Undo button:** after a tap the buttons become a badge plus one Undo button, e.g. `❌ Rejected by @user · final at 14:03:30  [ ↩ Undo ]`. Undo (atomic: only if `pending_decision` is still set) restores the original card. When the 90 s window ends the bot edits the message once to the final static badge (`❌ Rejected by @user · 14:03`) with no buttons. Applies to Approve, Reject, COD Confirm and COD Cancel. The deadline is shown as a fixed time (no per-second edits, to respect Telegram rate limits).
- Reminders for stale `SUBMITTED` payments (1 h, 6 h, 24 h).
- The Telegram webhook is verified with the `X-Telegram-Bot-Api-Secret-Token` header.

---

## 10. Outbound webhooks

Events: `payment.created`, `payment.submitted`, `payment.confirmed` (COD), `payment.paid`, `payment.rejected`, `payment.reopened`, `payment.expired`, `payment.cancelled`, `payment.courier_updated`. Events fire only when a decision is **finalised** (after the Undo window) or when a courier event arrives.

```json
POST <merchant webhook_url>
x-smpg-signature: t=1731330000,v1=<hex hmac>
x-smpg-event: payment.rejected
{ "id": "evt_1", "type": "payment.rejected", "created": 1731330000,
  "data": { …payment object…, "retry_url": "https://…/c/pay_8f2k" } }
```
- Signature = `HMAC-SHA256(webhook_secret, "<t>.<raw body>")`. The SDK rejects if `|now − t| > 5 min` and compares in constant time.
- Retries with exponential backoff (1 m, 5 m, 30 m, 2 h, 12 h) until `2xx`; then marked failed. The merchant is told in Telegram after 3 failed attempts.
- Events carry a stable `id`; consumers must be idempotent. `payment.reopened` supersedes an earlier `payment.rejected`.
- **Fulfil prepaid orders on `payment.paid` only.** For COD, `payment.confirmed` = ship it, `payment.paid` = cash collected.
- On `payment.rejected`, tell the customer (email/SMS) and include `retry_url`.

---

## 11. SDK: `send-money-payment-gateway`

```ts
import { SMPG } from "send-money-payment-gateway";
const smpg = new SMPG(process.env.SMPG_API_KEY!, {
  baseUrl: process.env.SMPG_BASE_URL!,            // your deployed worker URL (required: no central hosted instance)
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});

// 1. Create and redirect
const pay = await smpg.payments.create({
  amount: 1250, external_order_id: order.id,
  customer: { name, phone },
  success_url: `${origin}/orders/${order.id}/thanks`,
  cancel_url: `${origin}/cart`,
}, { idempotencyKey: order.id });
redirect(pay.checkout_url);

// 2. Webhook (Next.js route handler)
export async function POST(req: Request) {
  const event = await smpg.webhooks.constructEvent(
    await req.text(), req.headers.get("x-smpg-signature")!);
  await applyPaymentEvent(event);       // idempotent
  return new Response("ok");
}

// 3. Helpers
await smpg.payments.retrieve("pay_8f2k");
await smpg.payments.list({ external_order_id: "ORD-1042" });
await smpg.payments.cancel("pay_8f2k");
```
Requirements: zero runtime deps, ESM + CJS, full TypeScript types generated from `openapi.yaml`, runs on Workers / Node 18+ / Vercel Edge / Deno / Bun, `constructEvent` takes the **raw** body.

---

## 12. Hosted checkout page

- English only, mobile-first, one screen, works without JS for COD (progressively enhanced for bKash/Nagad).
- Header: merchant logo, store name, amount, brand colour.
- Method picker (only enabled methods with available wallet capacity).
- **bKash/Nagad step:** assigned wallet number with copy button, exact `৳` amount with copy button, 3-step instructions, then `Your bKash/Nagad number` + `TrxID`/`TxnID`.
- **After submit:** "Thank you!" screen ("We received your payment details. The seller will verify them shortly, this can take a few minutes to a few hours."), then redirect to `success_url?payment_id=…&status=submitted`. **No polling, no waiting screen.**
- Revisiting `checkout_url` is state-aware: *Verifying* (with the submitted TrxID), *Paid* (link back to store), *Rejected* (reason-free message + resubmit form, max 3 attempts), *Expired* (late-submit form if within 24 h).
- Friction against abuse: format checks, burned-TrxID check, submission cap, honeypot field.
- URL note: without a custom domain the page lives on `*.workers.dev`; strong merchant branding on the page helps trust. A custom domain can be added later by changing `PUBLIC_BASE_URL`.

---

## 13. 🤖 Agent integration kit

Goal: a coding agent can add SMPG checkout to a fresh storefront in one pass without asking questions.

### 13.1 What we ship
1. `docs/llms.txt` + `llms-full.txt`: concise, link-indexed docs.
2. `openapi.yaml`: single source of truth for SDK types and docs.
3. `AGENTS.md` snippet (below).
4. Recipes: Next.js App Router (Vercel), SvelteKit, Cloudflare Worker (Hono), Express.
5. **Test mode**: `smpg_test_` keys plus Telegram `/test` commands to simulate bKash/Nagad submissions, courier events and approvals, so agents verify the full loop with no real money.
6. CLI `npx smpg init`: reads `.env`, verifies the key and base URL, registers the webhook URL, prints the checklist.

### 13.2 `AGENTS.md` snippet (paste into the storefront repo)
```md
## Payments (SMPG)
- Methods: COD, bKash Send Money, Nagad Send Money. All go through SMPG; never build custom payment code.
- Env vars (server only): SMPG_API_KEY, SMPG_WEBHOOK_SECRET, SMPG_BASE_URL.
- The customer flow is ASYNCHRONOUS. After submitting a TrxID the customer is sent to success_url immediately,
  while the merchant verifies later (minutes to hours). success_url does NOT mean paid.
- Checkout: create order (status `pending_payment`) → smpg.payments.create with external_order_id = order.id and
  idempotency key = order.id → redirect to checkout_url.
- Order statuses to implement: pending_payment, payment_verifying, paid, payment_rejected, cod_confirmed, shipped,
  delivered, cancelled.
- Webhook handler `applyPaymentEvent(event)` (idempotent, keyed by external_order_id):
  payment.submitted → payment_verifying · payment.paid → paid (prepaid: now fulfil) ·
  payment.rejected → payment_rejected + email/SMS the customer with data.retry_url ·
  payment.reopened → payment_verifying · payment.confirmed (COD) → cod_confirmed (ship) ·
  payment.courier_updated → store tracking status · payment.expired/cancelled → cancelled.
- Never fulfil a prepaid order from the success redirect. Verify webhooks with smpg.webhooks.constructEvent(rawBody, signatureHeader);
  read the RAW body, don't JSON-parse first.
- The order page must show "Payment is being verified" while status is payment_verifying.
- Amounts are integer BDT.
- Docs: <SMPG_BASE_URL>/llms.txt · API spec: <SMPG_BASE_URL>/openapi.yaml
```

### 13.3 Reference storefront contract
`orders(id, status[pending_payment|payment_verifying|paid|payment_rejected|cod_confirmed|shipped|delivered|cancelled], total, customer_*, shipping_*, payment_id, payment_method, courier_status, created_at)`, `order_items(...)`, `products(...)`. Unique `payment_id` per order. This is also the schema the future open-source e-commerce platform adopts.

### 13.4 Acceptance checklist agents must satisfy
- [ ] Order created before redirect; order id passed as `external_order_id`.
- [ ] Success page shows "verifying" for prepaid orders and never marks them paid.
- [ ] Webhook verifies signature on the raw body and rejects stale timestamps.
- [ ] `applyPaymentEvent` is idempotent and handles every event type above, including `payment.rejected` (customer notified with `retry_url`) and `payment.reopened`.
- [ ] Order page re-fetches status (`GET /v1/payments/:id` server-side) instead of trusting query params.
- [ ] Secrets only in server env.
- [ ] All 3 methods work end to end in test mode.

### 13.5 Hosting notes
- **Vercel:** webhook as a route handler (`nodejs` or `edge`); env vars in project settings.
- **Cloudflare Workers:** SDK works unchanged; `wrangler secret put`; orders in D1.

---

## 14. Deployment (self-host on Cloudflare)

No central instance and no custom domain are required. Anyone can deploy their own.

1. Clone the repo; `pnpm install`.
2. `wrangler d1 create smpg` and `wrangler r2 bucket create smpg-logos`; apply migrations (`wrangler d1 migrations apply smpg`).
3. Create a Telegram bot with **@BotFather** (suggested name "SMPG Payments Bot").
4. Set secrets: `wrangler secret put TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ENCRYPTION_KEY`.
5. Vars in `wrangler.toml`: `PUBLIC_BASE_URL` (the `*.workers.dev` URL, set after the first deploy), `UNDO_WINDOW_SECONDS=90`, `SUBMITTED_TTL_HOURS=72`, `CREATED_TTL_MINUTES=60`, `LATE_SUBMIT_HOURS=24`.
6. `wrangler deploy`, then register the Telegram webhook (`setWebhook` with the secret token). A `pnpm run setup` script does this.
7. Message the bot `/start`, add wallets, copy the API keys into the storefront's env.

Cron triggers: every minute (finalise due decisions, send reminders, expire payments, retry webhooks).

---

## 15. Security (non-regulatory)

- API keys hashed (SHA-256), shown once, rotatable, separate test/live.
- Webhook secrets and courier webhook secrets encrypted at rest. **No courier or wallet credentials are ever stored.**
- TrxID uniqueness enforced by the DB (`trx_submissions` unique index), not application code.
- Telegram callbacks authenticated by chat ID + secret-token header; atomic transitions prevent double-taps and races.
- Courier webhooks authenticated per provider and per merchant URL token; deduplicated.
- Rate limits on customer endpoints; honeypot on forms.
- Payment ids are random (≥128 bits); public endpoints expose only status.
- Logs never contain keys or secrets; phone numbers are masked.
- Merchant kill switch: `/pause`.
- Tier 2 SMS: SMS is untrusted input; device registration via Telegram (`/device add`), signed requests, strict per-provider parsers with fixtures.

---

## 16. Tier 2: SMS auto-approval (future)

- Android companion app reads bKash/Nagad confirmation SMS, parses `{provider, trx_id, amount, sender}` and posts to `POST /v1/sms-events`, signed with a per-device key.
- Core matches `(method, trx_id, amount)` against a `SUBMITTED` payment (and `sender_number` when present, and the wallet number if the SMS includes it). On match → `PAID`, `verification_method='sms'`, and the Telegram card becomes a read-only receipt.
- Unmatched SMS events are kept for a few hours so a TrxID submitted *after* its SMS still auto-approves.
- Amount mismatch → stay `SUBMITTED` and warn the merchant.
- Sideload the APK if the Play Store SMS-permission policy blocks listing.

---

## 17. Roadmap

| Milestone | Scope |
|---|---|
| **M0 Skeleton** | Monorepo, D1 migrations, `openapi.yaml`, CI, Worker scaffold, deploy script |
| **M1 Core flow** | Payments API, state machine incl. Undo window and `/reopen`, Telegram onboarding + approval cards, wallets + rotation, bKash/Nagad submit flow, test mode |
| **M2 Checkout + COD** | Hosted checkout (async thank-you flow), COD flow, expiry/reminder cron, late submission |
| **M3 SDK + webhooks** | Signed webhooks with retries, NPM SDK, CLI `npx smpg init` |
| **M4 Agent kit** | `llms.txt`, recipes, `AGENTS.md`, example storefronts, acceptance checklist verified with real agent runs |
| **M5 Hardening** | Abuse/load tests, co-approvers, `/pause`, audit views in Telegram |
| **M6 Couriers** | Steadfast, Pathao and Carrybee webhook adapters (built against each provider's webhook docs, fixture-tested) |
| **M7 Tier 2** | Android SMS app + `/v1/sms-events` |
| **Later** | COD advance payments; Bangla UI; custom-domain guide; open-source e-commerce platform built on SMPG; Shopify/WordPress plugins |

**Definition of done for M4:** a fresh coding agent, given only the `AGENTS.md` snippet and `llms.txt`, builds a working storefront with all three methods against test mode in a single session, including correct handling of rejection and reopen.

---

## 18. Platform plugins (brief)

- **Shopify:** the native Payments App route (offsite payments extension) needs Shopify's invitation-only Payments Partner approval, so it's not a target now. A workable path later: a Shopify app that adds a *manual payment method* plus a Thank-you/Order-status checkout UI extension that links to SMPG's hosted checkout, and marks the order paid through the Admin API on `payment.paid`. Needs per-shop OAuth/token storage and a `shop → merchant` mapping. The async flow fits Shopify's manual-payment model well.
- **WordPress / WooCommerce:** a standard custom gateway plugin (extends `WC_Payment_Gateway`) that creates an SMPG payment, redirects to `checkout_url`, leaves the order `on-hold` while verifying, and exposes a webhook endpoint that moves it to `processing` on `payment.paid`. Likely the simpler of the two.
- Both are thin wrappers over the same REST API and webhooks; no core changes needed.
