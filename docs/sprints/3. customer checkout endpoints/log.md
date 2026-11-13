# Sprint 3: Customer Checkout Endpoints Log

## Date: 2026-11-13

### Summary of Changes
Implemented and verified the public, customer-facing checkout API (`/c/:id/*`) on `apps/core`. These endpoints require no API keys (the high-entropy payment ID acts as the bearer capability) and power both the customer checkout frontend (`apps/checkout`) and the asynchronous Telegram bot merchant notification dispatch. The implementation includes public session data retrieval, real-time wallet capacity calculation, dynamic method selection, TrxID/TxnID normalization and burning, anti-bot honeypots, late submission grace periods, and cached polling status checks.

---

### Files Added / Modified

#### Customer Checkout API Router
- [`apps/core/src/api/checkout.ts`](file:///home/bast0k/projects/smpg/apps/core/src/api/checkout.ts):
  - **Why created**: Implements the public customer-facing checkout endpoints specified in Sections 3, 4.1, 6, and 8 of [SMPG Master Plan](file:///home/bast0k/projects/smpg/docs/SMPG_Plan.md).
  - **What changed**:
    - `GET /c/:id/data`:
      - Validates payment ID and merchant account status (`merchant.paused`).
      - Returns public session data: amount, currency (BDT), order reference, store branding (`store_name`, `brand_color`, `logo_key`).
      - Real-time method availability: computes available methods (`available_methods`) dynamically by checking `merchant.cod_enabled` and wallet capacity (`reservedToday + amount <= dailyLimit`) for bKash and Nagad.
      - Returns assigned wallet number and label if already allocated.
      - Computes late submission eligibility (`can_late_submit`: true if expired past 60m but within the 24-hour grace window).
      - Exposes remaining attempts (`attempts_remaining = 3 - attempts`).
    - `POST /c/:id/method`:
      - Allows customer to choose or change payment method when payment is in `CREATED` status.
      - If `bkash` or `nagad`: calls `assignWalletForPayment` to allocate an active wallet with available capacity and updates `payments.walletId`. Returns `400 no_wallet_available` if limits are exhausted.
      - If `cod`: validates `merchant.cod_enabled`, transitions status to `CONFIRMED`, logs audit event in `payment_events`, and dispatches the COD confirmation card to the merchant's Telegram chat via `sendCodNotification`.
    - `POST /c/:id/submit`:
      - Anti-bot detection: rejects requests if the hidden `honeypot` field contains text.
      - State guards: permits submissions only for `CREATED` or `REJECTED` payments (rejects `PAID`, `CANCELLED`, or already `SUBMITTED`).
      - Attempt ceiling: enforces a hard cap of 3 submission attempts (`too_many_attempts`).
      - Expiration & late submit handling: if submitted after the 60-minute window, allows submission within the 24-hour grace window (`LATE_SUBMIT_HOURS`) and flags `lateSubmission = 1`. Outside 24 hours, rejects with `payment_expired`.
      - Validation: enforces 11-digit Bangladeshi sender numbers (`^01[3-9]\d{8}$`) and 6-30 alphanumeric characters for TrxID/TxnID. Normalizes TrxID by stripping whitespace and converting to uppercase.
      - **TrxID Burning**: In live mode (`mode = 'live'`), checks `trx_submissions` and rejects previously submitted IDs (`400 trx_id_already_used`), burning every valid submitted ID into `trx_submissions`.
      - State machine update: transitions status atomically to `SUBMITTED`, increments `attempts`, and logs audit trail.
      - Telegram notification dispatch: formats provider-specific cards (`TrxID` for bKash, `TxnID` for Nagad, `⏰ submitted late` badge if applicable) with inline `[ ✅ Approve ]` and `[ ❌ Reject ]` action buttons via `sendPaymentSubmissionNotification`.
      - Returns optimistic thank-you response with immediate redirect URL: `${success_url}?payment_id=...&status=submitted`.
    - `GET /c/:id/status`:
      - Lightweight status endpoint for order thank-you pages and status polling.
      - Sets HTTP response header `Cache-Control: public, max-age=5` to prevent server load spikes.

#### Application Router Entrypoint
- [`apps/core/src/index.ts`](file:///home/bast0k/projects/smpg/apps/core/src/index.ts):
  - **What changed**: Mounted `checkoutRouter` at `/c` (`app.route('/c', checkoutRouter)`), exposing `/c/:id/data`, `/c/:id/method`, `/c/:id/submit`, and `/c/:id/status`.

#### Automated Integration Test Suite
- [`apps/core/test/checkout.test.ts`](file:///home/bast0k/projects/smpg/apps/core/test/checkout.test.ts):
  - **Why created**: Integration test suite verifying all customer checkout endpoints and security boundaries.
  - **What changed**: Implemented 15 automated test cases covering:
    - Public checkout data retrieval with store branding and method filtering.
    - Paused merchant account 403 rejection.
    - 24-hour late submission eligibility calculation.
    - Dynamic wallet allocation upon method selection.
    - COD confirmation and state transition.
    - Rejection of method selection when not in `CREATED` status.
    - Successful TrxID submission with uppercase normalization and DB burning.
    - Honeypot bot submission rejection.
    - Duplicate TrxID burning enforcement in live mode (`trx_id_already_used`).
    - Validation of invalid mobile phone numbers.
    - Late submission past 60 min marking `late_submission = 1`.
    - Submission ceiling enforcement (rejection after 3 attempts with `too_many_attempts`).
    - Polled status check with `Cache-Control: public, max-age=5` verification.

---

### Verification Performed
1. **Automated Test Suite**: Ran `bun test` across the workspace — all **43 tests** passed across 7 test files (328ms).
2. **TypeScript Compilation**: Ran `bun run typecheck` across all workspace projects (`@smpg/core`, `@smpg/checkout`, `send-money-payment-gateway`) — **0 errors, 0 warnings**.

---

### Things to Look Out For / Future Tasks
1. **Sprint 4 (Outbound Webhooks)**: Implement cryptographic HMAC-SHA256 signing (`x-smpg-signature`) and retry queue for events triggered when payment decisions are finalized.
2. **Sprint 5 (Hosted Checkout Frontend)**: Build the SvelteKit frontend in `apps/checkout` connecting directly to these `/c/:id/*` endpoints.
