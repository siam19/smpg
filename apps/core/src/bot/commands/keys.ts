import { and, eq, isNull } from 'drizzle-orm';
import type { BotContext } from '../context';
import { apiKeys, merchants } from '../../db/schema';
import { generateApiKey, generatePrefixedId, sha256 } from '../../services/crypto';

export async function handleKeysCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const subAction = parts[1]?.toLowerCase();
  const targetMode = parts[2]?.toLowerCase() as 'live' | 'test' | undefined;

  // 1. Rotation logic: /keys rotate live|test
  if (subAction === 'rotate') {
    if (targetMode !== 'live' && targetMode !== 'test') {
      await ctx.reply('⚠️ Usage: <code>/keys rotate live</code> or <code>/keys rotate test</code>', {
        parse_mode: 'HTML',
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Revoke old active keys in this mode
    await ctx.db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiKeys.merchantId, ctx.merchant.id),
          eq(apiKeys.mode, targetMode),
          isNull(apiKeys.revokedAt)
        )
      );

    // Generate new key
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
        '',
        `<i>All previous ${targetMode} keys have been revoked. Update your storefront environment.</i>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  // 2. Listing active keys
  const activeKeys = await ctx.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.merchantId, ctx.merchant.id), isNull(apiKeys.revokedAt)));

  const lines = [
    `🔑 <b>Your Active API Keys</b>`,
    `Merchant ID: <code>${ctx.merchant.id}</code>`,
    '',
  ];

  for (const k of activeKeys) {
    const modeBadge = k.mode === 'live' ? '🟢 Live' : '🟡 Test';
    lines.push(`• ${modeBadge}: <code>${k.prefix}...</code> (Created: ${new Date(k.createdAt * 1000).toLocaleDateString()})`);
  }

  lines.push(
    '',
    '<i>For security, full secret keys are only shown at creation or rotation.</i>',
    'To rotate: <code>/keys rotate live</code> or <code>/keys rotate test</code>'
  );

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleStorePauseCommand(ctx: BotContext, pause: boolean) {
  if (!ctx.merchant) return;

  await ctx.db
    .update(merchants)
    .set({ paused: pause ? 1 : 0 })
    .where(eq(merchants.id, ctx.merchant.id));

  const statusText = pause
    ? '⏸ <b>Store Paused</b>. New payments will be rejected.'
    : '▶️ <b>Store Resumed</b>. Now accepting payments.';

  await ctx.reply(statusText, { parse_mode: 'HTML' });
}
