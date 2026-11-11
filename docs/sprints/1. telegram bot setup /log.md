# Sprint 1: Telegram Bot Setup Log

## Date: 2026-11-11

### Summary of Changes
Created the architectural design and implementation roadmap for the **SMPG Payments Bot** using [grammY](https://grammy.dev), TypeScript, Drizzle ORM, Cloudflare D1, and Hono within `apps/core`.

---

### Files Added / Modified
- [`docs/sprints/1. telegram bot setup /plan.md`](file:///home/bast0k/projects/smpg/docs/sprints/1.%20telegram%20bot%20setup%20/plan.md): Comprehensive architecture document detailing:
  - System architecture and request flow via `/v1/telegram-webhook`
  - Cloudflare Worker + grammY + D1 integration without cold-start latency
  - Drizzle ORM schema mapping for D1 SQLite
  - Merchant onboarding (`/start`), wallet rotation, and commands
  - Real-time notification cards with atomic double-tap prevention
  - 90-second Undo window state machine and cron-backed finalization
  - 7-phase step-by-step implementation roadmap

---

### Next Steps
1. Install `grammy`, `drizzle-orm`, and `drizzle-kit` in `apps/core`.
2. Define `src/db/schema.ts` with Drizzle ORM matching our existing D1 schema.
3. Scaffold grammY bot instance and Hono webhook route with `X-Telegram-Bot-Api-Secret-Token` validation.
