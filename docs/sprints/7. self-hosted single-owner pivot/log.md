# Sprint 7: Self-Hosted Single-Owner Multi-Store Pivot Log

## Date: 2026-11-24

### Status
Completed

---

### Architectural Context & Decisions

Following a review of Sprints 0–6, we identified that the codebase had drifted into a centralized multi-tenant payment gateway (one shared Telegram bot `@spmg_payments_bot`, public stranger registration with KYC prompts, hardcoded personal `workers.dev` URLs, and a separate hosted checkout Worker). Operating a centralized gateway introduces regulatory/compliance liabilities that contradict SMPG's original mission.

In this sprint, SMPG pivoted cleanly to a **self-hosted, single-owner, multi-store architecture**:

1. **Single Self-Hosted Worker (Option A)**: Each deployer creates their own Telegram bot via `@BotFather` and deploys one lightweight Cloudflare Worker (`apps/core`) + one D1 database into their own Cloudflare account. Works with storefronts hosted on any platform/stack.
2. **Single-Owner, Multi-Store**: The bot is strictly locked to its owner (`OWNER_TELEGRAM_ID` or one-time `/start <SETUP_TOKEN>` claim). The owner can create and manage multiple stores (`stores`), each with its own API keys and webhook URL, backed by owner-level personal bKash/Nagad SIM wallets (`wallets`) that enforce real per-SIM daily caps across stores.
3. **Clean Squashed D1 Schema**: Legacy migrations (`0001`–`0003`) were replaced by a single clean `0001_initial_schema.sql` free of KYC columns (`owner_name`, `phone_number`, `can_provide_nid`, `onboarding_step`) and hosted-checkout branding columns (`brand_color`, `logo_key`).
4. **No Hosted Checkout Worker (`apps/checkout` Removed)**: Storefronts implement their own native checkout UI using the official SDK (`SMPG` / `SMPGCheckout`) and reference UI examples in `examples/`. Dropping `apps/checkout` and the unused R2 `BUCKET` binding allows anyone to self-host SMPG on Cloudflare's free tier with **no credit card required**.
5. **Streamlined, Zero-Emoji Telegram Bot**: Stripped out KYC onboarding, `/logout`, `/reset`, `/brand_color`, and open stranger registration; added strict owner lock, `/stores` multi-store management, wallet-to-store scoping, and removed ALL emojis across every bot message, card, button, menu, and notification alert.

---

### Files Added / Modified / Deleted

#### 1. Core Backend, Schema & Hosted Checkout Removal (`apps/core`, `apps/checkout`)
- **Deleted**:
  - `apps/checkout/` (entire SvelteKit hosted checkout worker removed)
  - `apps/core/migrations/0002_merchant_onboarding.sql`
  - `apps/core/migrations/0003_nullable_payment_method.sql`
- **Added**:
  - `apps/core/src/services/payment.ts` (centralized `formatPaymentResponse`, `selectPaymentMethod`, `submitPaymentTrx`, `expireStalePayments` shared across `/v1/payments` and `/c/:id/*`)
  - `apps/core/wrangler.toml.example`
- **Modified**:
  - `apps/core/migrations/0001_initial_schema.sql` & `apps/core/src/db/schema.ts` (clean squashed schema: `bot_config`, `stores`, `wallets`, `api_keys`, `payments` with `store_id` & `telegram_message_id`, `trx_submissions`, `payment_events`, `webhook_deliveries` with `store_id`)
  - `apps/core/src/types.ts` (removed `BUCKET` and `PUBLIC_BASE_URL`; added optional `OWNER_TELEGRAM_ID`, `SETUP_TOKEN`)
  - `apps/core/wrangler.toml`, `apps/core/.env.example`, `.env.example` (removed hardcoded `database_id`, `PUBLIC_BASE_URL`, and `[[r2_buckets]]`)
  - `apps/core/src/index.ts` (wired `expireStalePayments(db)` into 1-minute cron; lazy dynamic `import('./bot')`)
  - `apps/core/src/services/wallet.ts` (store-eligible wallet filtering `store_id IS NULL OR store_id = storeId` with cross-store daily cap aggregation)
  - `apps/core/src/services/notification.ts`, `apps/core/src/services/webhook.ts`, `apps/core/src/services/decision.ts` (normalized snake_case webhook payloads, Telegram card finalization on undo expiry via `payment.telegramMessageId`, `payment.reopened` webhook queueing, COD `payment.confirmed` queueing, zero emojis in alert text, removed `retry_url`)
  - `apps/core/src/api/auth.ts`, `apps/core/src/api/payments.ts`, `apps/core/src/api/checkout.ts` (`store` context, `store_id`, `store_paused` 403, optional `success_url`/`cancel_url`, removed `checkout_url`/`brand_color`/`logo_key`)
  - `apps/core/test/helpers/mock-d1.ts` and `apps/core/test/{crypto,wallet,payments,checkout,webhook,sdk-integration}.test.ts`

#### 2. Telegram Bot Overhaul (`apps/core/src/bot/`)
- **Deleted**:
  - `apps/core/src/bot/handlers/onboarding.ts`
  - `apps/core/src/bot/commands/settings.ts`
  - `apps/core/src/bot/commands/keys.ts`
- **Added**:
  - `apps/core/src/bot/commands/stores.ts` (`/stores` multi-store CRUD, key rotation, webhook config + test ping via `deliverWebhookPayload`, COD toggle, pause/resume, delete)
- **Modified**:
  - `apps/core/src/bot/context.ts`, `apps/core/src/bot/middleware/auth.ts`, `apps/core/src/bot/middleware/error.ts`, `apps/core/src/bot/commands/start.ts` (strict single-owner lock via `OWNER_TELEGRAM_ID` or `/start <SETUP_TOKEN>` claim; unauthorized users rejected with zero DB writes)
  - `apps/core/src/bot/commands/wallets.ts`, `apps/core/src/bot/commands/payments.ts`, `apps/core/src/bot/commands/test.ts`, `apps/core/src/bot/callbacks/menu.ts`, `apps/core/src/bot/callbacks/decision.ts`, `apps/core/src/bot/callbacks/undo.ts`, `apps/core/src/bot/handlers/text.ts`, `apps/core/src/bot/views/cards.ts`, `apps/core/src/bot/views/keyboards.ts`, `apps/core/src/bot/index.ts` (ASCII usage bars, store-scoped/shared wallets, `[Store Name]` headers on cards, `payment.telegramMessageId` tracking, `/reopen`, zero emojis everywhere)
  - `apps/core/test/bot.test.ts` (owner lock, claim flow, card formatting, automated zero-emoji scan)

#### 3. SDK & Embedded Checkout Examples (`packages/sdk`, `examples/`)
- **Modified (`packages/sdk`)**:
  - `packages/sdk/src/checkout.ts` (removed hardcoded `fhasan-gch.workers.dev` default; `baseUrl` required via string or `{ baseUrl, fetchFn }`)
  - `packages/sdk/src/types.ts` (`store_id`, optional/nullable `success_url`, `attempts`/`attempts_remaining`, `CheckoutStoreInfo { id, name }`, removed `checkout_url`/`brand_color`/`logo_key`/`retry_url`)
  - `packages/sdk/src/webhooks.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`, `packages/sdk/README.md`, `packages/sdk/test/webhooks.test.ts`
- **Added (`packages/sdk`, `examples/react`)**:
  - `packages/sdk/test/checkout.test.ts`
  - `examples/react/SMPGCheckoutBox.tsx` & `examples/react/README.md` (drop-in React/Next.js embedded checkout component)
- **Modified (`examples/storefront`)**:
  - `examples/storefront/src/app.ts`, `examples/storefront/src/db.ts`, `examples/storefront/package.json`, `examples/storefront/tsconfig.json`, `examples/storefront/test/storefront.test.ts` (removed hardcoded URL fallback, switched to `x-smpg-signature`, added `payment.reopened`, added embedded checkout HTML routes `/`, `/checkout/:orderId`, `/orders/:orderId` with inline rejection retry)

#### 4. Setup CLI, Root Scripts, Docs & Agent Skills
- **Added**:
  - `scripts/setup.ts` (zero-dependency Bun interactive 1-command self-deploy CLI)
- **Modified**:
  - `package.json` (added `"setup": "bun run scripts/setup.ts"`)
  - `README.md`, `AGENTS.md`, `docs/AGENTS.md` (synced identical to root `AGENTS.md`), `docs/openapi.yaml`, `docs/llms.txt`, `docs/llms-full.txt`, `docs/SMPG_Plan.md`
  - `skills/smpg-integration/SKILL.md` & `.agents/skills/smpg-integration/SKILL.md` (verified identical)
  - `docs/sprints/7. self-hosted single-owner pivot/goals.md` & `docs/sprints/7. self-hosted single-owner pivot/log.md`

---

### Verification Performed

All verification checks passed with zero issues:

1. **Monorepo Build, Typecheck & Tests**:
   - `bun run build`: **PASS** (`send-money-payment-gateway` ESM/CJS/DTS built cleanly)
   - `bun run typecheck`: **PASS** (0 errors across all workspaces)
   - `bun test`: **72 pass, 0 fail** (400 `expect()` assertions across 10 test files)
2. **Fresh Local D1 Migration & Worker Bundle**:
   - `wrangler d1 migrations apply smpg --local --persist-to /tmp/smpg-verify-d1`: **PASS** (`0001_initial_schema.sql` — 14 SQL commands executed cleanly)
   - `wrangler deploy --dry-run`: **PASS** (`650.91 KiB / gzip: 119.82 KiB`, clean bindings: `env.DB`, `UNDO_WINDOW_SECONDS`, `SUBMITTED_TTL_HOURS`, `CREATED_TTL_MINUTES`, `LATE_SUBMIT_HOURS`; zero R2 or missing bindings)
3. **Code & Hygiene Audit**:
   - `apps/checkout` deleted with zero broken references in `package.json` or active code/docs.
   - Zero hardcoded `fhasan-gch` or `spmg_payments_bot` references outside historical sprint logs.
   - Zero `r2_buckets`, `BUCKET`, `brand_color`, `logo_key`, `checkout_url`, `merchant_id`, or `retry_url` leftovers in active code, SDK, OpenAPI, docs, or skills.
   - Webhook header standardized to `x-smpg-signature` across the entire repo (`docs/AGENTS.md` identical to `AGENTS.md`).
   - Zero emojis across `apps/core/src/bot/**/*.ts` and `apps/core/src/services/{notification,webhook,decision}.ts`.
   - `skills/smpg-integration/SKILL.md` and `.agents/skills/smpg-integration/SKILL.md` verified identical via `diff -u`.
   - `scripts/setup.ts` bundles cleanly via `bun build --target=bun` (11.84 KB).

---

### Post-Sprint Follow-Up: Onboarding Polish & Stylized Setup CLI (`@clack/prompts`)

Following real-world end-to-end testing of `bun run setup`, several UX and reliability improvements were added:

- **README & Branding (`README.md`, `docs/smpg-logo.png`)**:
  - Added `docs/smpg-logo.png` centered header, explicit prerequisites (Telegram account, Cloudflare free-tier account, Bun), and a step-by-step `@BotFather` + storefront `.env` connection guide.
- **Failsafe Edge Webhook Registration & Secret Trimming (`apps/core/src/index.ts`, `apps/core/src/bot/index.ts`, `scripts/setup.ts`)**:
  - Added `POST /v1/telegram-webhook/register` on `apps/core` so Cloudflare's edge handles Telegram `setWebhook`, `getMe`, and `setMyCommands` (eliminating local ISP rate-limit issues and returning HTTP `429` + `retry_after` cleanly).
  - Removed the trailing `\n` bug in `putSecret()` (piping trimmed secret values verbatim) and added defensive `.trim()` on `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_TOKEN`.
  - Simplified owner onboarding by dropping the default 32-char `SETUP_TOKEN` claim link in favor of first-`/start` auto-claim (with optional explicit `OWNER_TELEGRAM_ID`).
- **Resumable Setup State (`scripts/setup.ts`, `.gitignore`)**:
  - Added step-level state persistence in `.smpg-setup-state.json` (`0600` permissions, gitignored, auto-deleted on completion, `--reset` flag supported) so interrupted runs resume cleanly from the last successful step.
- **Stylized Interactive CLI (`scripts/setup.ts`, `package.json`, `bun.lock`)**:
  - Added `@clack/prompts` (`1.9.0`) and `picocolors` (`1.1.1`) as root `devDependencies` (keeping `packages/sdk` zero-dependency).
  - Rebuilt `scripts/setup.ts` with a cyan `SMPG` ASCII banner, `p.intro()` / `p.outro()`, visual resume checklist (`p.note()` + `p.select()`), masked token entry (`p.password()`), elapsed-timer spinners (`p.spinner({ indicator: 'timer' })`) for D1/deploy/webhook registration with live per-second `429` countdowns, a block progress bar (`p.progress({ style: 'block' })`) for secret uploads, and a rounded summary `p.box()`.
  - Verified with strict `tsc --noEmit` on `scripts/setup.ts`, `bun build scripts/setup.ts --target=bun` (77.72 KB), `bun run typecheck`, and `bun test` (**72 pass, 0 fail**).
