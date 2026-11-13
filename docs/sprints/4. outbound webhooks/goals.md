# Sprint 4: Outbound Webhooks & Event Delivery

> **Status**: Planned  
> **Reference**: [SMPG Master Plan - Section 7 (Data Model), Section 10 (Outbound Webhooks), Section 11 (SDK Integration)](../../SMPG_Plan.md)

---

## Sprint Objectives
Build and deploy the outbound webhook dispatch engine and retry queue in `apps/core`. Storefronts and developers rely on signed webhooks to fulfill orders asynchronously once payments are verified and finalized.

---

## Deliverables & Scope

1. **Webhook Event Types**:
   - `payment.created`: Payment session initialized.
   - `payment.submitted`: Customer submitted TrxID/TxnID and sender number.
   - `payment.confirmed`: COD order confirmed by merchant.
   - `payment.paid`: Payment approved by merchant (post-undo finalization) or confirmed delivered.
   - `payment.rejected`: Payment rejected by merchant (carries `data.retry_url`).
   - `payment.reopened`: Payment reopened via Telegram `/reopen`.
   - `payment.expired`: Payment timed out without submission or decision.
   - `payment.cancelled`: Payment cancelled by merchant or customer.
   - `payment.courier_updated`: Parcel status updated via courier webhook.

2. **Cryptographic Signing**:
   - Retrieve and decrypt merchant's `webhook_secret` using Worker's `ENCRYPTION_KEY` (AES-256-GCM).
   - Generate unix timestamp `t` (seconds).
   - Compute `HMAC-SHA256` signature using Web Crypto API over `${t}.${rawJsonBody}`.
   - Attach HTTP headers:
     - `Content-Type: application/json`
     - `x-smpg-signature: t=<timestamp>,v1=<hex_hmac>`
     - `x-smpg-event: <event_type>`
     - `User-Agent: SMPG-Webhook/1.0`

3. **Queueing & Delivery Mechanism**:
   - In-memory immediate delivery attempt using Cloudflare Workers `fetch()`.
   - On delivery success (`2xx`), log event and record `delivered_at`.
   - On delivery failure (non-2xx, timeout, or DNS failure):
     - Insert/update record in `webhook_deliveries` table.
     - Exponential backoff schedule: 1 min, 5 min, 30 min, 2 hours, 12 hours (up to 5 attempts).
     - Calculate `next_attempt_at`.

4. **Cloudflare Cron Worker Integration**:
   - Hook into scheduled cron trigger (running every minute).
   - Query pending retries: `SELECT * FROM webhook_deliveries WHERE next_attempt_at <= ? AND delivered_at IS NULL LIMIT 25`.
   - Attempt delivery, increment `attempt`, and update `next_attempt_at` or `delivered_at`.
   - Merchant Notification: If 3 consecutive delivery attempts fail, dispatch an alert card to the merchant's Telegram chat warning that their server is unreachable.

5. **Webhook Test & Verification**:
   - Test endpoint/bot command `/webhook <url>` that immediately queues and sends a `ping` event with a mock payload to verify the merchant's endpoint.
   - End-to-end integration test validating compatibility with `packages/sdk`'s `smpg.webhooks.constructEvent()`.
