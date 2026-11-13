import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { webhookCallback } from 'grammy';
import { createDb } from './db';
import { createBot } from './bot';
import { finalizeDueDecisions } from './services/decision';
import { processPendingWebhookDeliveries } from './services/webhook';
import { authMiddleware, type ApiVariables } from './api/auth';
import { paymentsRouter } from './api/payments';
import { checkoutRouter } from './api/checkout';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

app.use('*', cors());

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'smpg-core',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Root
app.get('/', (c) => {
  return c.text('SMPG Core API - Send Money Payment Gateway');
});

// Primary Payments REST API (Bearer auth)
app.use('/v1/payments/*', authMiddleware);
app.use('/v1/payments', authMiddleware);
app.route('/v1/payments', paymentsRouter);

// Customer Checkout Endpoints (Public capability URLs)
app.route('/c', checkoutRouter);

// Telegram Bot Webhook endpoint
app.post('/v1/telegram-webhook', async (c) => {
  const secretHeader = c.req.header('X-Telegram-Bot-Api-Secret-Token');

  if (!c.env.TELEGRAM_WEBHOOK_SECRET || secretHeader !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text('Unauthorized: Invalid secret token', 401);
  }

  const db = createDb(c.env.DB);
  const bot = createBot(c.env, db);

  return webhookCallback(bot, 'hono')(c);
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const db = createDb(env.DB);
          const bot = env.TELEGRAM_BOT_TOKEN ? createBot(env, db) : undefined;

          // 1. Finalize decisions whose 90s undo window has passed
          const finalized = await finalizeDueDecisions(db, bot);
          if (finalized > 0) {
            console.log(`[Cron] Finalized ${finalized} due decisions`);
          }

          // 2. Process pending outbound webhook deliveries with retries
          const webhookResults = await processPendingWebhookDeliveries(db, env, bot);
          if (webhookResults.processed > 0) {
            console.log(
              `[Cron] Processed ${webhookResults.processed} webhooks (${webhookResults.succeeded} succeeded, ${webhookResults.failed} queued for retry)`
            );
          }
        } catch (cronErr) {
          console.error('[Cron] Error during scheduled maintenance:', cronErr);
        }
      })()
    );
  },
};
