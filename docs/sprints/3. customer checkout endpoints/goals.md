# Sprint 3: Customer Checkout Endpoints & TrxID Verification

> **Status**: Planned  
> **Reference**: [SMPG Master Plan - Section 3 (Customer Experience), Section 4.1 (TrxID / TxnID), Section 6 (State Machine), Section 8 (Customer-Facing Endpoints)](../../SMPG_Plan.md)

---

## Sprint Objectives
Build and deploy the public customer-facing payment lifecycle API (`/c/:id/*`) on `apps/core`. These endpoints require no API keys (the high-entropy payment ID acts as the bearer capability) and power both the hosted checkout frontend and the merchant Telegram notification dispatch.

---

## Deliverables & Scope

1. **`GET /c/:id/data` (Public Checkout Data)**:
   - Validate payment ID existence.
   - Return safe, public payment metadata:
     - Amount (integer BDT), order reference (`external_order_id`).
     - Store branding: `store_name`, `brand_color`, `logo_url` (from R2 `BUCKET`).
     - Payment status and state details (`CREATED`, `SUBMITTED`, `CONFIRMED`, `PAID`, `REJECTED`, `EXPIRED`, `CANCELLED`).
     - Available methods based on merchant settings and real-time wallet capacity (`cod`, `bkash`, `nagad`).
     - Assigned wallet number and provider label (if already selected or pre-assigned).
     - Expiration timestamp and retry eligibility (attempts remaining up to 3).

2. **`POST /c/:id/method` (Method Selection & Wallet Assignment)**:
   - Accept `{ "method": "bkash" | "nagad" | "cod" }`.
   - If `bkash` or `nagad`:
     - Run wallet rotation algorithm (`balanced` or `fill_first`) taking daily limit (৳25,000) and today's usage into account.
     - Atomically assign `wallet_id` and return wallet details.
     - Return `400` with code `no_wallet_available` if all wallets have exhausted capacity.
   - If `cod`:
     - If COD is enabled for merchant, transition payment to `CONFIRMED`.
     - Dispatch COD confirmation card to merchant's Telegram chat.
     - Return updated payment state.

3. **`POST /c/:id/submit` (Submit TrxID & Sender Number)**:
   - Accept `{ "sender_number": "01XXXXXXXXX", "trx_id": "...", "honeypot": "" }`.
   - Anti-abuse:
     - Reject if honeypot is populated.
     - Enforce rate limiting / submission cap (max 3 resubmission attempts after rejection).
   - Normalization & Validation:
     - Normalize `trx_id`: trim, strip internal whitespace, convert to uppercase.
     - Validate `sender_number`: regex `^01[3-9]\d{8}$`.
     - Format check on `trx_id` (alphanumeric, 8-15 chars).
   - TrxID Burning:
     - Record in `trx_submissions` table.
     - Fail with `400 trx_id_already_used` if the TrxID was ever submitted previously across any merchant or payment.
   - State Transition:
     - Transition from `CREATED` or `REJECTED` -> `SUBMITTED`.
     - Late submission check: If payment expired past 60 min but within 24 hours (`LATE_SUBMIT_HOURS`), accept submission and flag `submitted_late = 1`.
   - Audit Trail & Notification:
     - Insert row into `payment_events`.
     - Format and dispatch interactive Telegram notification card to the merchant (`💸 bKash payment ... [ ✅ Approve ] [ ❌ Reject ]`).
   - Return `200 OK` with thank-you payload and redirect instruction to `success_url?payment_id=...&status=submitted`.

4. **`GET /c/:id/status` (Polled / Order Page Status Check)**:
   - Fast, cacheable (Cache-Control: public, max-age=5) endpoint returning `{ "status": "SUBMITTED" | "PAID" | ... }`.
   - Allows thank-you and order tracking pages to query progress without leaking merchant configuration.

5. **Telegram Card Integration**:
   - Deliver rich notification cards with inline keyboards matching Provider type (`TrxID` for bKash, `TxnID` for Nagad).
   - Display `⏰ submitted late` badge if submitted past initial window.
   - Support inline callback actions wired into the 90-second undo state machine.

6. **Automated Testing**:
   - Integration tests covering normal flow, late submissions, duplicate TrxID burning, method rotation, and rate limiting.
