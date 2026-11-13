import { createMiddleware } from 'hono/factory';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db';
import { apiKeys, merchants, type ApiKey, type Merchant } from '../db/schema';
import { sha256 } from '../services/crypto';
import type { Env } from '../types';

export interface ApiVariables {
  merchant: Merchant;
  mode: 'test' | 'live';
  apiKey: ApiKey;
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: ApiVariables;
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      {
        error: {
          code: 'unauthorized',
          message: 'Missing or malformed Authorization header. Expected Bearer <api_key>',
        },
      },
      401
    );
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey.startsWith('smpg_live_') && !rawKey.startsWith('smpg_test_')) {
    return c.json(
      {
        error: {
          code: 'unauthorized',
          message: 'Invalid API key format. Must begin with smpg_live_ or smpg_test_',
        },
      },
      401
    );
  }

  const db = createDb(c.env.DB);
  const keyHashed = await sha256(rawKey);

  const keyRecord = await db
    .select({
      apiKey: apiKeys,
      merchant: merchants,
    })
    .from(apiKeys)
    .innerJoin(merchants, eq(apiKeys.merchantId, merchants.id))
    .where(and(eq(apiKeys.keyHash, keyHashed), isNull(apiKeys.revokedAt)))
    .get();

  if (!keyRecord) {
    return c.json(
      {
        error: {
          code: 'unauthorized',
          message: 'Invalid or revoked API key',
        },
      },
      401
    );
  }

  if (keyRecord.merchant.paused === 1) {
    return c.json(
      {
        error: {
          code: 'merchant_paused',
          message: 'This merchant account is currently paused. Please resume via Telegram bot.',
        },
      },
      403
    );
  }

  c.set('merchant', keyRecord.merchant);
  c.set('mode', keyRecord.apiKey.mode as 'test' | 'live');
  c.set('apiKey', keyRecord.apiKey);

  await next();
});
