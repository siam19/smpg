# Sprint 2: Core Payments REST API Log

## Date: 2026-11-13

### Summary of Changes
Architected, built, and verified the primary merchant REST API (`/v1/payments`) on `apps/core` (Hono on Cloudflare Workers). This enables merchant storefronts and the official `@smpg/sdk` to create payment sessions, retrieve payment statuses with inline lazy finalization, list payments with pagination and filtering, and cancel unpaid sessions with idempotency protection and atomic state transitions.

---

### Files Added / Modified

#### Database & Schema
- [`apps/core/migrations/0003_nullable_payment_method.sql`](file:///home/bast0k/projects/smpg/apps/core/migrations/0003_nullable_payment_method.sql):
  - **Why created**: In the initial schema migration, `payments.method` had a `NOT NULL` constraint. Per Section 8 of `SMPG_Plan.md`, merchants may omit `method` when creating a payment via `POST /v1/payments` to allow the customer to choose their preferred method (bKash, Nagad, or COD) on the hosted checkout page (`POST /c/:id/method`).
  - **What changed**: Rebuilt the `payments` table in SQLite with `method TEXT CHECK (method IS NULL OR method IN ('cod', 'bkash', 'nagad'))`, preserving all existing foreign key constraints and indexes.
- [`apps/core/src/db/schema.ts`](file:///home/bast0k/projects/smpg/apps/core/src/db/schema.ts):
  - **What changed**: Updated Drizzle ORM definition of `payments.method` from `text('method').notNull()` to `text('method')` to match the D1 migration and allow `null` for unassigned checkout sessions.

#### Authentication Middleware
- [`apps/core/src/api/auth.ts`](file:///home/bast0k/projects/smpg/apps/core/src/api/auth.ts):
  - **Why created**: Required to authenticate all merchant REST API calls under `/v1/payments/*` via Bearer token.
  - **What changed**:
    - Validates presence of `Authorization: Bearer <key>` header.
    - Validates key format (`smpg_live_...` or `smpg_test_...`).
    - Hashes key using Web Crypto SHA-256 (`sha256`) and looks up `api_keys` where `revoked_at IS NULL`.
    - Inner joins with `merchants` table and enforces kill switch check (`paused = 0`). Returns `403 Forbidden` (`code: "merchant_paused"`) if the merchant paused operations.
    - Attaches `merchant`, `mode` (`live` | `test`), and `apiKey` to Hono context variables (`ApiVariables`).

#### Payments API Router
- [`apps/core/src/api/payments.ts`](file:///home/bast0k/projects/smpg/apps/core/src/api/payments.ts):
  - **Why created**: Implements the core REST API endpoints specified in Section 8 of `SMPG_Plan.md`.
  - **What changed**:
    - `formatPaymentResponse()`: Helper normalizing SQLite rows into snake_case `Payment` objects matching the OpenAPI spec and SDK interface (derives `checkout_url`, parses JSON `metadata`, formats ISO 8601 strings).
    - `POST /v1/payments`:
      - Idempotency handling: Checks `Idempotency-Key` header against `(merchant_id, idempotency_key)` to return existing session on retries without duplicating payments.
      - Input validation: Enforces integer BDT amounts (`amount >= 1`), validates HTTP/HTTPS URLs for `success_url` and `cancel_url`, and enforces maximum length on `metadata`.
      - Method & wallet allocation: If `bkash` or `nagad`, calls `assignWalletForPayment` to pick an active wallet within today's daily limit (৳25,000). Returns `400 no_wallet_available` if capacity exhausted. If `cod`, checks `merchant.cod_enabled`. If omitted, leaves wallet unassigned for customer selection.
      - Expiration computation: Calculates `expires_at = now + CREATED_TTL_MINUTES * 60` (default 60 min).
      - Inserts `payments` record and `payment_events` audit trail row.
    - `GET /v1/payments/:id`:
      - Scoped to authenticated merchant (`404 invalid_request` if not found).
      - **Inline Lazy Finalization**: Checks if a 90-second undo window expired (`pending_decision` set and `decision_effective_at <= now`). Finalizes the state transition (`PAID` or `REJECTED`) inline via `finalizeDueDecisions` before returning the response.
    - `GET /v1/payments`:
      - Lists payments with optional filters: `external_order_id` and `status`.
      - Pagination via `limit` (default 20, max 100) and cursor, calculating `has_more`.
    - `POST /v1/payments/:id/cancel`:
      - Enforces state machine rules: allows cancellation only from `CREATED` or `CONFIRMED` states (rejects other states with `400 invalid_state`).
      - Updates status to `CANCELLED`, records audit event in `payment_events`, and queues outbound webhook delivery in `webhook_deliveries`.

#### App Router Mounting
- [`apps/core/src/index.ts`](file:///home/bast0k/projects/smpg/apps/core/src/index.ts):
  - **What changed**: Mounted `authMiddleware` and `paymentsRouter` on `/v1/payments` and `/v1/payments/*` on the main Hono application with full TypeScript context typing (`Env` and `ApiVariables`).

#### Automated Test Infrastructure & Suites
- [`apps/core/test/helpers/mock-d1.ts`](file:///home/bast0k/projects/smpg/apps/core/test/helpers/mock-d1.ts):
  - **Why created**: Provides an in-memory SQLite (`bun:sqlite`) test harness wrapping Cloudflare D1 and Drizzle ORM interfaces. Executes migrations `0001`, `0002`, and `0003` to create an identical test environment without needing remote Cloudflare credentials or network access.
- [`apps/core/test/payments.test.ts`](file:///home/bast0k/projects/smpg/apps/core/test/payments.test.ts):
  - **Why created**: Integration test suite verifying all Sprint 2 endpoints and edge cases.
  - **What changed**: Implemented 17 automated tests covering:
    - Missing/invalid/revoked API keys and paused merchant account rejections.
    - Payment creation with bKash wallet assignment.
    - Payment creation with omitted method for checkout choice.
    - Daily wallet limit capacity exhaustion (`no_wallet_available`).
    - Merchant COD disabled validation (`method_not_enabled`).
    - Input validation on negative/float amounts.
    - Replay protection with `Idempotency-Key`.
    - Session retrieval and inline lazy undo finalization.
    - Filtered and paginated list queries.
    - Payment cancellation and terminal state validation.
- [`apps/core/test/sdk-integration.test.ts`](file:///home/bast0k/projects/smpg/apps/core/test/sdk-integration.test.ts):
  - **Why created**: Validates end-to-end compatibility between the official `@smpg/sdk` (`send-money-payment-gateway`) client and the Hono REST API.
  - **What changed**: Tested `smpg.payments.create()`, `smpg.payments.retrieve()`, `smpg.payments.list()`, and `smpg.payments.cancel()`, ensuring request/response schemas align 100%.

---

### Verification Performed
1. **D1 Migration**: Applied `0003_nullable_payment_method.sql` locally via `bun x wrangler d1 migrations apply smpg --local` (11 SQL commands executed successfully).
2. **Automated Unit & Integration Tests**: Executed `bun test` across the entire workspace — **28 pass, 0 fail, 111 assertions** executed in 186ms.
3. **TypeScript Typecheck**: Ran `bun run typecheck` across all workspace projects (`@smpg/core`, `@smpg/checkout`, `send-money-payment-gateway`) — **0 errors, 0 warnings**.

---

### Things to Look Out For / Future Tasks
1. **Remote D1 Migration**: When deploying to Cloudflare Workers (`wrangler deploy`), apply migration `0003_nullable_payment_method.sql` to the remote D1 database via `wrangler d1 migrations apply smpg --remote`.
2. **Sprint 3 (Customer Checkout Endpoints)**: Implement `/c/:id/*` routes (`GET /c/:id/data`, `POST /c/:id/method`, `POST /c/:id/submit`, `GET /c/:id/status`) to consume the payments created in Sprint 2.
