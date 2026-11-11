import { and, eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchantWallets } from '../../db/schema';
import { generatePrefixedId } from '../../services/crypto';
import { renderWalletsDashboard } from '../callbacks/menu';

const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

export async function handleWalletsCommand(ctx: BotContext) {
  return renderWalletsDashboard(ctx);
}

export async function handleAddWalletCommand(ctx: BotContext, provider: 'bkash' | 'nagad') {
  if (!ctx.merchant) return;

  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const number = parts[1];
  const label = parts.slice(2).join(' ') || undefined;

  // If no number argument was provided (e.g. tapped from Telegram menu), prompt with ForceReply!
  if (!number) {
    const providerName = provider === 'bkash' ? 'bKash' : 'Nagad';
    const examplePlaceholder = provider === 'bkash' ? '017XXXXXXXX [label]' : '018XXXXXXXX [label]';
    await ctx.reply(
      `📱 <b>Adding ${providerName} Wallet</b>\n\nPlease reply with your 11-digit ${providerName} number and an optional label.\n\n<b>Example:</b> <code>${provider === 'bkash' ? '017XXXXXXXX Primary' : '018XXXXXXXX Nagad1'}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: examplePlaceholder },
      }
    );
    return;
  }

  if (!BD_PHONE_REGEX.test(number)) {
    await ctx.reply(
      `⚠️ Please provide a valid 11-digit Bangladeshi phone number.\n\nUsage: <code>/add_${provider} 01XXXXXXXXX [optional_label]</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Check if wallet already exists for this merchant and provider
  const [existing] = await ctx.db
    .select()
    .from(merchantWallets)
    .where(
      and(
        eq(merchantWallets.merchantId, ctx.merchant.id),
        eq(merchantWallets.provider, provider),
        eq(merchantWallets.number, number)
      )
    )
    .limit(1);

  if (existing) {
    await ctx.reply(`⚠️ Wallet <code>${number}</code> is already registered under ${provider}.`, {
      parse_mode: 'HTML',
    });
    return renderWalletsDashboard(ctx);
  }

  const now = Math.floor(Date.now() / 1000);
  await ctx.db.insert(merchantWallets).values({
    id: generatePrefixedId('wal'),
    merchantId: ctx.merchant.id,
    provider,
    number,
    label: label ?? null,
    dailyLimit: 25000,
    priority: 100,
    active: 1,
    createdAt: now,
  });

  const providerName = provider === 'bkash' ? 'bKash' : 'Nagad';
  await ctx.reply(
    `✅ <b>${providerName} wallet added successfully!</b>\nNumber: <code>${number}</code>\nDaily Limit: ৳25,000`,
    { parse_mode: 'HTML' }
  );
  return renderWalletsDashboard(ctx);
}
