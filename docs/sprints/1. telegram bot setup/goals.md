# Sprint 1: Telegram Bot Setup & Merchant Experience

> **Status**: Completed  
> **Reference**: [SMPG Master Plan - Section 4.2 (Wallets), Section 6 (State Machine), Section 9 (Telegram Bot)](../../SMPG_Plan.md)

---

## Sprint Objectives
Implement the central Telegram bot inside `apps/core` using **grammY** and **Drizzle ORM**, providing a dashboard-less merchant management interface with frictionless onboarding, multi-wallet rotation, and real-time transaction approvals with an atomic **90-second Undo window**.

---

## Deliverables & Scope

1. **grammY & Drizzle ORM Setup**:
   - Install `grammy`, `drizzle-orm`, and `drizzle-kit` in `apps/core`.
   - Type-safe schema mapping in `apps/core/src/db/schema.ts` matching Cloudflare D1 tables.
   - Pre-cached `botInfo` configuration to eliminate cold-start network latency on Cloudflare Workers.
   - Mounted at `POST /v1/telegram-webhook` with `X-Telegram-Bot-Api-Secret-Token` validation.

2. **Merchant Onboarding Flow (`/start`)**:
   - Multi-step interactive onboarding: Name -> Phone number validation (`01XXXXXXXXX`) -> NID/Passport verification question (`Yes | No`) -> Welcome & `[ 🏪 Create Store ]` button -> Store Name -> Brand color picker with HTML color codes link and `[ ⏭ Skip ]` button.
   - Automatic generation of Live and Test API keys (`smpg_live_...`, `smpg_test_...`) and encrypted webhook secrets (AES-GCM-256).
   - Developer `/logout` command to clear test sessions and re-run onboarding.

3. **Multi-Number Wallet Rotation (`/wallets`)**:
   - Manage multiple bKash and Nagad accounts to distribute daily personal limits (~৳25,000/day).
   - Visual ASCII progress bar for daily reserved usage vs limit in Asia/Dhaka time.
   - `balanced` (default) and `fill_first` rotation strategies.
   - Interactive wallet management: edit limits, pause/resume, delete.

4. **Notification Cards & 90-Second Undo State Machine**:
   - Real-time notification cards with inline `[ ✅ Approve ]` and `[ ❌ Reject ]` buttons.
   - Atomic conditional SQL update (`pending_decision IS NULL`) preventing button double-taps.
   - 90-second grace window with `[ ↩ Undo ]` button.
   - Cron-backed finalization transitioning status to `PAID`/`REJECTED` and queueing outbound webhooks.
   - `/reopen <payment_id>` support for reopening rejected payments within 7 days.
