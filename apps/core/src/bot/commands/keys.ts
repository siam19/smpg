import { and, eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { apiKeys, merchants } from '../../db/schema';
import { generateApiKey, generatePrefixedId, sha256 } from '../../services/crypto';
import { renderKeysDashboard } from '../callbacks/menu';

export async function handleKeysCommand(ctx: BotContext) {
  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const subAction = parts[1]?.toLowerCase();
  const targetMode = parts[2]?.toLowerCase() as 'live' | 'test' | undefined;

  // Direct CLI command fallback: /keys rotate live|test
  if (subAction === 'rotate' && (targetMode === 'live' || targetMode === 'test') && ctx.merchant) {
    const now = Math.floor(Date.now() / 1000);

    await ctx.db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiKeys.merchantId, ctx.merchant.id),
          eq(apiKeys.mode, targetMode)
        )
      );

    const newKeyData = generateApiKey(targetMode);
    const keyHash = await sha256(newKeyData.key);

    await ctx.db.insert(apiKeys).values({
      id: generatePrefixedId('key'),
      merchantId: ctx.merchant.id,
      keyHash,
      prefix: newKeyData.prefix,
      mode: targetMode,
      createdAt: now,
    });

    await ctx.reply(
      [
        `🔑 <b>${targetMode.toUpperCase()} API Key Rotated!</b>`,
        '',
        `New API Key (save this now, shown only once):`,
        `<code>${newKeyData.key}</code>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return renderKeysDashboard(ctx);
  }

  return renderKeysDashboard(ctx);
}

export async function handleStorePauseCommand(ctx: BotContext, pause: boolean) {
  if (!ctx.merchant) return;

  await ctx.db
    .update(merchants)
    .set({ paused: pause ? 1 : 0 })
    .where(eq(merchants.id, ctx.merchant.id));
  ctx.merchant.paused = pause ? 1 : 0;

  const statusText = pause
    ? '⏸ <b>Store Paused</b>. New payments will be rejected.'
    : '▶️ <b>Store Resumed</b>. Now accepting payments.';

  await ctx.reply(statusText, { parse_mode: 'HTML' });
}
