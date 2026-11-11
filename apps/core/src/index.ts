import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

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

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Scheduled cron trigger runs every minute:
    // 1. Finalise decisions whose 90s undo window has passed
    // 2. Send reminders for stale SUBMITTED payments (1h, 6h, 24h)
    // 3. Mark expired CREATED and SUBMITTED payments
    // 4. Retry pending webhook deliveries with exponential backoff
    ctx.waitUntil(
      (async () => {
        // Will be implemented in Milestone 1 & 2
      })()
    );
  },
};
