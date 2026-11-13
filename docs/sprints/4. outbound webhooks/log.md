# Sprint 4: Outbound Webhooks Log

## Date: 2026-11-13

### Status
Planned

---

### Planned Tasks
- [ ] Implement webhook signing utility (`createWebhookSignature`) in `apps/core/src/services/webhook.ts`
- [ ] Implement `dispatchWebhookEvent` engine with immediate execution and database queue fallback
- [ ] Add `webhook_deliveries` processor to scheduled cron handler in `apps/core/src/index.ts`
- [ ] Implement exponential backoff schedule (1m, 5m, 30m, 2h, 12h)
- [ ] Add Telegram bot alert notification for merchants on 3 consecutive failed attempts
- [ ] Connect bot `/webhook` command to dispatch an immediate test ping event
- [ ] Write end-to-end tests verifying delivery and signature verification against `@smpg/sdk`
