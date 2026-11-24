import { and, eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { wallets } from '../../db/schema';
import { generatePrefixedId } from '../../services/crypto';
import { renderWalletsDashboard } from '../callbacks/menu';

const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

export async function handleWalletsCommand(ctx: BotContext) {
  return renderWalletsDashboard(ctx);
}

export async function handleAddWalletCommand(ctx: BotContext, provider: 'bkash' | 'nagad') {
  if (!ctx.isOwner) return;

  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const number = parts[1];
  const label = parts.slice(2).join(' ') || undefined;
  const providerName = provider === 'bkash' ? 'bKash' : 'Nagad';

  if (!number) {
    const examplePlaceholder = provider === 'bkash' ? '017XXXXXXXX [label]' : '018XXXXXXXX [label]';
    const exampleVal = provider === 'bkash' ? '017XXXXXXXX Primary' : '018XXXXXXXX Nagad1';
    await ctx.reply(
      `<b>Adding ${providerName} Wallet</b>\n\nPlease reply with your 11-digit ${providerName} number and an optional label.\n\n<b>Example:</b> <code>${exampleVal}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: examplePlaceholder },
      }
    );
    return;
  }

  if (!BD_PHONE_REGEX.test(number)) {
    await ctx.reply(
      `Invalid phone number. Please provide a valid 11-digit Bangladeshi number starting with 013-019.\n\nUsage: <code>/add_${provider} 01XXXXXXXXX [optional_label]</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const [existing] = await ctx.db
    .select()
    .from(wallets)
    .where(and(eq(wallets.provider, provider), eq(wallets.number, number)))
    .limit(1);

  if (existing) {
    await ctx.reply(`Wallet <code>${number}</code> is already registered under ${providerName}.`, {
      parse_mode: 'HTML',
    });
    return renderWalletsDashboard(ctx);
  }

  const now = Math.floor(Date.now() / 1000);
  await ctx.db.insert(wallets).values({
    id: generatePrefixedId('wal'),
    storeId: null,
    provider,
    number,
    label: label ?? null,
    dailyLimit: 25000,
    priority: 100,
    active: 1,
    createdAt: now,
  });

  await ctx.reply(
    `<b>${providerName} wallet added</b>\nNumber: <code>${number}</code>\nScope: All Stores (Shared)\nDaily Limit: ৳25,000`,
    { parse_mode: 'HTML' }
  );
  return renderWalletsDashboard(ctx);
}
