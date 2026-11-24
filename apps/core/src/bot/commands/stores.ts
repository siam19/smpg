import type { Database } from '../../db';
import type { Env } from '../../types';
import { apiKeys, stores, type Store } from '../../db/schema';
import {
  encryptAesGcm,
  generateApiKey,
  generatePrefixedId,
  generateWebhookSecret,
  sha256,
} from '../../services/crypto';
import type { BotContext } from '../context';
import { renderStoresDashboard } from '../callbacks/menu';

export interface CreatedStoreBundle {
  store: Store;
  liveKey: string;
  testKey: string;
  webhookSecret: string;
}

/**
 * Creates a new store along with its initial Live + Test API keys and AES-GCM encrypted webhook secret.
 */
export async function createStoreWithCredentials(
  db: Database,
  env: Env,
  name: string
): Promise<CreatedStoreBundle> {
  const now = Math.floor(Date.now() / 1000);
  const storeId = generatePrefixedId('str');
  const rawWebhookSecret = generateWebhookSecret();
  const encryptedWebhookSecret = await encryptAesGcm(rawWebhookSecret, env.ENCRYPTION_KEY);

  const store: Store = {
    id: storeId,
    name,
    codEnabled: 1,
    webhookUrl: null,
    webhookSecret: encryptedWebhookSecret,
    paused: 0,
    createdAt: now,
  };

  await db.insert(stores).values(store);

  const liveKeyData = generateApiKey('live');
  const testKeyData = generateApiKey('test');
  const [liveHash, testHash] = await Promise.all([
    sha256(liveKeyData.key),
    sha256(testKeyData.key),
  ]);

  await db.insert(apiKeys).values([
    {
      id: generatePrefixedId('key'),
      storeId,
      keyHash: liveHash,
      prefix: liveKeyData.prefix,
      mode: 'live',
      revokedAt: null,
      createdAt: now,
    },
    {
      id: generatePrefixedId('key'),
      storeId,
      keyHash: testHash,
      prefix: testKeyData.prefix,
      mode: 'test',
      revokedAt: null,
      createdAt: now,
    },
  ]);

  return {
    store,
    liveKey: liveKeyData.key,
    testKey: testKeyData.key,
    webhookSecret: rawWebhookSecret,
  };
}

export async function handleStoresCommand(ctx: BotContext) {
  return renderStoresDashboard(ctx);
}

export async function handleHelpCommand(ctx: BotContext) {
  const helpText = [
    '<b>SMPG Bot Guide</b>',
    '',
    'Manage your self-hosted stores, receiving wallets, and payment verifications:',
    '',
    '<b>Commands:</b>',
    '- /start - Open Main Menu',
    '- /stores - Create and manage stores, webhooks, and API keys',
    '- /wallets - Manage bKash/Nagad receiving wallets and daily caps',
    '- /payments - View recent payments and reopen rejected ones',
    '- /reopen &lt;payment_id&gt; - Reopen a rejected payment (within 7 days)',
    '- /test [bkash|nagad|cod] [store_id] - Simulate a payment notification',
    '- /add_bkash [number] [label] - Add a bKash receiving wallet',
    '- /add_nagad [number] [label] - Add a Nagad receiving wallet',
    '- /help - Show this guide',
    '',
    '<b>Quick Payment Decisions:</b>',
    'Tap Approve/Reject on any payment card, or reply directly with "ok", "y", "thik ache" to approve, or "no", "reject", "fake" to reject.',
  ].join('\n');

  await ctx.reply(helpText, { parse_mode: 'HTML' });
}
