# Telegram Bot Architecture & Implementation Plan

> **Sprint**: Sprint 1 - Telegram Bot Setup  
> **Target Package**: `apps/core` (Cloudflare Worker + D1 + R2)  
> **Tech Stack**: [grammY](https://grammy.dev), TypeScript, Drizzle ORM / D1, Cloudflare Workers, Hono  

---

## 1. Executive Overview

The **SMPG Payments Bot** serves as the **merchant control center** for the entire payment gateway. Instead of maintaining a complex web dashboard with logins and sessions, merchants configure wallets, set branding, receive real-time payment alerts, approve/reject transactions with an atomic **90-second Undo window**, and monitor incoming volume directly within Telegram.

The bot runs inside `apps/core` as a webhook handler mounted on Hono, communicating directly with Cloudflare D1 via Drizzle ORM and scheduled via Cloudflare Cron Triggers.

---

## 2. Architecture & Request Lifecycle

```
Telegram Cloud
      │
      │ HTTPS POST /v1/telegram-webhook
      │ Header: X-Telegram-Bot-Api-Secret-Token
      ▼
┌─────────────────────────────────────────────────────────────┐
│ apps/core (Cloudflare Worker)                               │
│                                                             │
│  1. Secret Token Middleware (Hono)                          │
│     Rejects unauthorized requests immediately               │
│                                                             │
│  2. grammY Webhook Handler (webhookCallback)                │
│     Bot initialized with botInfo to avoid getMe API latency │
│                                                             │
│  3. Middleware Pipeline                                     │
│     ├── Error Boundary (catch errors & return 200 OK)       │
│     ├── D1 / Drizzle Context Injection (ctx.db)             │
│     ├── Merchant Auth / Session Context (ctx.merchant)      │
│     └── Rate Limiter / Group Permissions Guard              │
│                                                             │
│  4. Route Dispatcher                                        │
│     ├── Commands (/start, /wallets, /reopen, etc.)          │
│     ├── Inline Button Callbacks ([Approve], [Reject], Undo) │
│     └── Media Uploads (Store Logo to R2)                    │
└─────────────────────────────────────────────────────────────┘
      │                           ▲
      ▼ D1 Queries                │ Telegram API (sendMessage, editMessageText)
 Cloudflare D1 (SQLite)      Telegram Bot API
```

---

## 3. Directory & Module Structure

The bot code will be organized inside `apps/core/src/bot/` to ensure modularity, high cohesion, and ease of unit testing:

```text
apps/core/src/
├── bot/
│   ├── index.ts                  # Bot initialization, export webhook handler & bot instance
│   ├── context.ts                # Custom grammY Context (Env, Drizzle DB, authenticated merchant)
│   ├── middleware/
│   │   ├── auth.ts               # Authenticates Telegram user against merchants table
│   │   └── error.ts              # Catches errors, logs to console, friendly user alert
│   ├── commands/
│   │   ├── start.ts              # /start - Onboarding, key generation, welcome guide
│   │   ├── wallets.ts            # /wallets, /add_bkash, /add_nagad, /wallet_limit, /wallet_pause
│   │   ├── settings.ts           # /store_name, /logo, /brand_color, /cod, /rotation
│   │   ├── keys.ts               # /keys, /keys rotate live|test
│   │   ├── payments.ts           # /payments (last 10), /reopen <payment_id>
│   │   ├── system.ts             # /pause, /resume, /mode, /help
│   │   └── test.ts               # /test bkash|nagad|cod (test mode simulations)
│   ├── callbacks/
│   │   ├── decision.ts           # Handles inline [Approve], [Reject], [Confirm], [Cancel]
│   │   └── undo.ts               # Handles [↩ Undo] button during 90s grace window
│   ├── views/
│   │   ├── cards.ts              # Notification card formatters (HTML/MarkdownV2)
│   │   └── keyboards.ts          # Inline keyboards for approvals, undo, and settings
│   └── services/
│       ├── notification.ts       # Dispatches cards to merchants (called by payments API / cron)
│       └── reminder.ts           # Stale payment reminder notifications (1h, 6h, 24h)
├── db/
│   ├── index.ts                  # Drizzle D1 client setup
│   └── schema.ts                 # Type-safe Drizzle schema for D1 SQLite
├── services/
│   ├── crypto.ts                 # AES-GCM encryption & API key SHA-256 hashing
│   ├── wallet.ts                 # Wallet rotation algorithm & daily limit tracking
│   └── webhook.ts                # Outbound merchant webhook dispatcher
├── types.ts                      # Cloudflare Worker Env & Shared Types
└── index.ts                      # Main worker entry (Hono app + Cron triggers)
```

---

## 4. Database Schema with Drizzle ORM (`src/db/schema.ts`)

In accordance with our database schema, we define type-safe Drizzle tables:

1. **`merchants`**:
   - `id` (text, primary key, `mrc_xxx`)
   - `telegramChatId` (integer, unique)
   - `storeName` (text)
   - `logoKey` (text)
   - `brandColor` (text, default `#000000`)
   - `codEnabled` (integer, boolean, default 1)
   - `rotationStrategy` (text, `'balanced'` | `'fill_first'`)
   - `webhookUrl` (text)
   - `webhookSecret` (text, encrypted with AES-GCM)
   - `testMode` (integer, boolean, default 1)
   - `paused` (integer, boolean, default 0)
   - `createdAt` (integer, unix epoch timestamp)

2. **`merchantWallets`**:
   - `id` (text, primary key, `wal_xxx`)
   - `merchantId` (text, references merchants.id)
   - `provider` (text, `'bkash'` | `'nagad'`)
   - `number` (text)
   - `label` (text)
   - `dailyLimit` (integer, default 25000)
   - `priority` (integer, default 100)
   - `active` (integer, boolean, default 1)
   - `createdAt` (integer)

3. **`apiKeys`**:
   - `id` (text, primary key, `key_xxx`)
   - `merchantId` (text, references merchants.id)
   - `keyHash` (text, unique SHA-256)
   - `prefix` (text, e.g. `smpg_live_ab12`)
   - `mode` (text, `'test'` | `'live'`)
   - `revokedAt` (integer, nullable)
   - `createdAt` (integer)

4. **`payments`**:
   - `id` (text, primary key, `pay_xxx`)
   - `merchantId` (text, references merchants.id)
   - `mode` (text, `'test'` | `'live'`)
   - `externalOrderId` (text)
   - `method` (text, `'cod'` | `'bkash'` | `'nagad'`)
   - `walletId` (text, references merchantWallets.id)
   - `amount` (integer)
   - `status` (text: `CREATED`, `SUBMITTED`, `CONFIRMED`, `PAID`, `REJECTED`, `EXPIRED`, `CANCELLED`)
   - `trxId` (text)
   - `senderNumber` (text)
   - `customerName` / `customerPhone` (text)
   - `successUrl` / `cancelUrl` (text)
   - `metadata` (text JSON)
   - `idempotencyKey` (text)
   - `attempts` (integer, default 0)
   - `pendingDecision` (text, nullable: `'approve'` | `'reject'` | `'confirm'` | `'cancel'`)
   - `decisionActor` (text, nullable: `telegram:@username`)
   - `decisionEffectiveAt` (integer, unix epoch for 90s undo expiration)
   - `lateSubmission` (integer, default 0)
   - `expiresAt` (integer)
   - `createdAt` / `updatedAt` (integer)

5. **`trxSubmissions`**:
   - `id` (integer primary key autoIncrement)
   - `paymentId` (text)
   - `method` (text)
   - `trxId` (text)
   - `senderNumber` (text)
   - `outcome` (text)
   - `mode` (text)
   - `createdAt` (integer)

6. **`paymentEvents`**: Audit trail for all transitions (`fromStatus`, `toStatus`, `actor`, `note`).

---

## 5. Merchant Lifecycle & Commands

### 5.1 Onboarding (`/start`)
When a user launches the bot:
1. Check if `telegram_chat_id` already exists in `merchants`.
2. If new:
   - Generate ID `mrc_<nano/random>`.
   - Generate test and live API keys:
     - `smpg_live_<random32>`
     - `smpg_test_<random32>`
   - Hash keys using SHA-256 for database storage (`key_hash`).
   - Generate a cryptographically secure 32-byte webhook secret, encrypt it with `ENCRYPTION_KEY` (AES-GCM-256), and store it.
   - Reply with an onboarding message displaying the live and test API keys (shown **once**), webhook secret, and interactive buttons to configure their first bKash/Nagad wallet.

### 5.2 Wallet Management
- `/add_bkash 01XXXXXXXXX [label]` & `/add_nagad 01XXXXXXXXX [label]`:
  - Validates Bangladeshi phone number format (`^01[3-9]\d{8}$`).
  - Sets default daily limit (৳25,000) and active status.
- `/wallets`:
  - Queries wallets for the merchant.
  - Calculates `reserved_today` for Asia/Dhaka day boundary:
    `SUM(amount)` from payments in `CREATED`, `SUBMITTED`, `PAID` created today.
  - Displays formatted progress bar:
    ```
    📱 bKash-1: 01712345678
       ৳18,500 / ৳25,000 [████████░░] 74%
       Status: Active
    ```
- `/wallet_limit <label or number> <amount>`: Adjusts threshold.
- `/wallet_pause <number>` / `/wallet_resume <number>`.
- `/rotation balanced|fill_first`:
  - `balanced`: Assigns wallet with lowest `reserved_today`.
  - `fill_first`: Fills highest priority wallet first until limit reached.

### 5.3 Payment Inspection & Operations
- `/payments`: Lists the 10 most recent payments with emoji status badges (`⏳ SUBMITTED`, `✅ PAID`, `❌ REJECTED`).
- `/reopen <payment_id>`:
  - Allowed within **7 days** of rejection.
  - Precondition: customer has not submitted a newer TrxID.
  - Updates status to `SUBMITTED`, writes audit event (`actor: telegram:@user`), and dispatches `payment.reopened` outbound webhook.

---

## 6. Real-Time Notification & 90-Second Undo State Machine

### 6.1 The Submitted Notification Card
When a customer submits a TrxID on the hosted checkout, the API calls `botService.sendPaymentSubmission(payment)`:
```
💸 bKash Payment · Order ORD-1042
Amount: ৳1,250
Sent to: 01712345678 (bKash-Primary)
TrxID: 9K3L2M1ABC
Sender: 01799887766

⚠️ Verify TrxID, amount & sender in your bKash app before approving.

[ ✅ Approve ]    [ ❌ Reject ]
```

### 6.2 Atomic Concurrency & Button Double-Tap Prevention
When the merchant taps **[ ✅ Approve ]**:
1. `callback_data` format: `v1:approve:pay_8f2k:<nonce>`.
2. Auth Check: Ensure the user belongs to the merchant chat.
3. **Atomic DB Update** (Prevents race conditions / double taps):
   ```sql
   UPDATE payments 
   SET pending_decision = 'approve',
       decision_actor = 'telegram:@username',
       decision_effective_at = strftime('%s', 'now') + 90,
       updated_at = strftime('%s', 'now')
   WHERE id = 'pay_8f2k' 
     AND status = 'SUBMITTED' 
     AND pending_decision IS NULL;
   ```
4. If `rowsAffected === 0`:
   - Another tap already happened or payment was updated.
   - Reply to callback query: `"Decision already recorded."` and refresh the message.
5. If `rowsAffected === 1`:
   - Acknowledge callback immediately: `ctx.answerCallbackQuery("Marked for approval (90s undo window)")`.
   - Edit Telegram card into the **Grace Period State**:
     ```
     💸 bKash Payment · Order ORD-1042
     Amount: ৳1,250
     TrxID: 9K3L2M1ABC

     ⏳ Approving by @username · Final in 90s
     [ ↩ Undo ]
     ```

### 6.3 Handling Undo
If the merchant taps **[ ↩ Undo ]**:
1. Atomic reset:
   ```sql
   UPDATE payments 
   SET pending_decision = NULL,
       decision_actor = NULL,
       decision_effective_at = NULL,
       updated_at = strftime('%s', 'now')
   WHERE id = 'pay_8f2k' 
     AND pending_decision IS NOT NULL;
   ```
2. If successful, restore original message card with `[ ✅ Approve ]` and `[ ❌ Reject ]`.

### 6.4 Decision Finalization (Cron & Lazy Backstop)
- When 90 seconds expire without an Undo:
  - Status officially becomes `PAID` (or `REJECTED`).
  - `payment_events` audit row is written.
  - Outbound webhook `payment.paid` (or `payment.rejected`) is queued and dispatched.
  - Telegram message is edited **once** to remove the Undo button and show the static final badge:
    ```
    💸 bKash Payment · Order ORD-1042 · ৳1,250
    TrxID: 9K3L2M1ABC
    ✅ Approved by @username (14:32:10)
    ```
- **Execution Mechanism**:
  1. **Cron Backstop**: The Cloudflare 1-minute cron (`scheduled`) scans:
     `SELECT * FROM payments WHERE pending_decision IS NOT NULL AND decision_effective_at <= unixepoch()`.
  2. **Lazy Read**: Any read endpoint (`GET /v1/payments/:id` or customer status check) checks if `decision_effective_at <= now` and triggers finalization inline if cron hasn't run yet.

---

## 7. Cloudflare Workers Performance Optimizations

1. **Pre-Supplied `botInfo`**:
   Cloudflare Workers is serverless and ephemeral. If grammY calls `getMe` on every cold start, it adds 200–500ms of latency to Telegram webhook updates. We store a static bot info string in `BOT_INFO` / compute it at build-time so `new Bot(token, { botInfo })` executes in 0ms.
2. **Fast Webhook Ack**:
   Always return `200 OK` quickly to Telegram. If background tasks (like outbound webhooks or image processing) need time, leverage `ctx.waitUntil()` in Cloudflare Workers execution context.
3. **Secret Token Header Verification**:
   Telegram webhooks are signed using `X-Telegram-Bot-Api-Secret-Token`. We validate this in Hono middleware before passing the request to grammY:
   ```typescript
   if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
     return c.text('Unauthorized', 401);
   }
   ```

---

## 8. Step-by-Step Implementation Roadmap

| Step | Tasks | Deliverables |
|---|---|---|
| **Phase 1: Dependencies & Schema** | Install `grammy`, `drizzle-orm`, `drizzle-kit`. Create `src/db/schema.ts` and initialize Drizzle D1 client. | Type-safe schema & D1 connection |
| **Phase 2: Bot Core & Auth** | Setup grammY instance, Hono webhook route with secret token validation, error boundary, and merchant lookup middleware. | Functional `/v1/telegram-webhook` endpoint |
| **Phase 3: Merchant Onboarding** | Implement `/start` command, API key generation (SHA-256), AES-GCM webhook secret encryption, and welcome UI. | Merchant registration & credentials flow |
| **Phase 4: Wallet Management** | Implement `/wallets`, `/add_bkash`, `/add_nagad`, `/wallet_limit`, `/wallet_pause`, `/rotation`. | Full multi-number wallet management |
| **Phase 5: Notification Cards & Actions** | Implement payment submission cards, inline keyboards, atomic `[Approve]` / `[Reject]`, and `[Undo]` button handler. | Interactive approval flow with 90s undo |
| **Phase 6: Expiration, Reminders & Cron** | Connect Cloudflare cron to finalize decisions, dispatch reminders (1h, 6h, 24h), and update Telegram cards. | Automated decision finalization & reminders |
| **Phase 7: Testing & Verification** | Add unit tests for bot handlers and card formatters using Bun / Vitest. | Verified bot test suite |
