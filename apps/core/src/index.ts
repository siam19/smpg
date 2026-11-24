import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { webhookCallback } from 'grammy';
import { createDb } from './db';
import { finalizeDueDecisions } from './services/decision';
import { expireStalePayments } from './services/payment';
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
    version: '0.2.0',
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
  const { createBot } = await import('./bot');
  const bot = createBot(c.env, db);

  return webhookCallback(bot, 'hono')(c);
});

// Failsafe Telegram Webhook Registration (runs from Cloudflare edge, immune to local ISP 429s)
app.post('/v1/telegram-webhook/register', async (c) => {
  const secretHeader = c.req.header('X-Telegram-Bot-Api-Secret-Token');

  if (!c.env.TELEGRAM_WEBHOOK_SECRET || secretHeader !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ ok: false, error: 'Unauthorized: Invalid secret token' }, 401);
  }

  if (!c.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500);
  }

  const origin = new URL(c.req.url).origin;
  const webhookUrl = `${origin}/v1/telegram-webhook`;

  const setWebhookRes = await fetch(
    `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: c.env.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: true,
      }),
    }
  );
  const setWebhookData = (await setWebhookRes.json()) as {
    ok: boolean;
    description?: string;
  };

  if (!setWebhookRes.ok || !setWebhookData.ok) {
    return c.json(
      {
        ok: false,
        error: setWebhookData.description || `setWebhook failed (HTTP ${setWebhookRes.status})`,
      },
      502
    );
  }

  // Best-effort: fetch bot info and register slash command menu from Cloudflare edge
  let botInfo: unknown = null;
  try {
    const getMeRes = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getMe`);
    const getMeData = (await getMeRes.json()) as { ok: boolean; result?: unknown };
    if (getMeRes.ok && getMeData.ok && getMeData.result) {
      botInfo = getMeData.result;
    }
  } catch {
    // Non-fatal
  }

  try {
    await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Open main menu or claim bot' },
          { command: 'stores', description: 'Manage stores, API keys, and webhooks' },
          { command: 'wallets', description: 'Manage bKash and Nagad receiving wallets' },
          { command: 'payments', description: 'View recent payments and reopen rejected ones' },
          { command: 'test', description: 'Simulate a test payment notification' },
          { command: 'help', description: 'Show command guide' },
        ],
      }),
    });
  } catch {
    // Non-fatal
  }

  return c.json({
    ok: true,
    webhook_url: webhookUrl,
    bot: botInfo,
  });
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const db = createDb(env.DB);
          const bot = env.TELEGRAM_BOT_TOKEN
            ? (await import('./bot')).createBot(env, db)
            : undefined;

          // 1. Expire stale CREATED payments to release reserved wallet capacity
          const expired = await expireStalePayments(db);
          if (expired > 0) {
            console.log(`[Cron] Expired ${expired} stale payments`);
          }

          // 2. Finalize decisions whose 90s undo window has passed
          const finalized = await finalizeDueDecisions(db, bot, env);
          if (finalized > 0) {
            console.log(`[Cron] Finalized ${finalized} due decisions`);
          }

          // 3. Process pending outbound webhook deliveries with retries
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
