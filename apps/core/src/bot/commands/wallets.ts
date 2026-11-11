import { and, eq, or } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchants, merchantWallets } from '../../db/schema';
import { generatePrefixedId } from '../../services/crypto';
import { getMerchantWalletsWithUsage } from '../../services/wallet';

const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

function renderProgressBar(percentage: number): string {
  const totalBars = 10;
  const filledBars = Math.min(totalBars, Math.round((percentage / 100) * totalBars));
  const emptyBars = totalBars - filledBars;
  return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
}

export async function handleWalletsCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const walletsWithUsage = await getMerchantWalletsWithUsage(ctx.db, ctx.merchant.id);

  if (walletsWithUsage.length === 0) {
    await ctx.reply(
      [
        '📱 <b>No wallets configured yet.</b>',
        '',
        'Add your receiving accounts to start accepting payments:',
        '• <code>/add_bkash 017XXXXXXXX [label]</code>',
        '• <code>/add_nagad 018XXXXXXXX [label]</code>',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  const lines = [
    `📱 <b>Your Receiving Wallets (Today in Asia/Dhaka)</b>`,
    `Rotation Strategy: <code>${ctx.merchant.rotationStrategy}</code>`,
    '',
  ];

  for (const item of walletsWithUsage) {
    const w = item.wallet;
    const providerBadge = w.provider === 'bkash' ? '🔴 bKash' : '🟠 Nagad';
    const labelText = w.label ? ` (${w.label})` : '';
    const statusText = w.active === 1 ? '🟢 Active' : '⏸ Paused';
    const progressBar = renderProgressBar(item.percentageUsed);

    lines.push(
      `${providerBadge}${labelText}: <code>${w.number}</code>`,
      `৳${item.reservedToday.toLocaleString('en-BD')} / ৳${w.dailyLimit.toLocaleString('en-BD')} [${progressBar}] ${item.percentageUsed}%`,
      `Status: ${statusText} · Priority: ${w.priority}`,
      ''
    );
  }

  lines.push(
    '<b>Manage Wallets:</b>',
    '• <code>/wallet_limit &lt;number/label&gt; &lt;amount&gt;</code>',
    '• <code>/wallet_pause &lt;number/label&gt;</code>',
    '• <code>/wallet_resume &lt;number/label&gt;</code>',
    '• <code>/rotation balanced|fill_first</code>'
  );

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

export async function handleAddWalletCommand(ctx: BotContext, provider: 'bkash' | 'nagad') {
  if (!ctx.merchant) return;

  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const number = parts[1];
  const label = parts.slice(2).join(' ') || undefined;

  if (!number || !BD_PHONE_REGEX.test(number)) {
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
    return;
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
    `✅ <b>${providerName} wallet added successfully!</b>\nNumber: <code>${number}</code>\nDaily Limit: ৳25,000\n\nType /wallets to view status.`,
    { parse_mode: 'HTML' }
  );
}

export async function handleWalletLimitCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const target = parts[1];
  const limitStr = parts[2];
  const limit = parseInt(limitStr, 10);

  if (!target || isNaN(limit) || limit < 1000) {
    await ctx.reply(
      '⚠️ Usage: <code>/wallet_limit &lt;number or label&gt; &lt;amount in BDT&gt;</code>\nExample: <code>/wallet_limit 017XXXXXXXX 30000</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const result = await ctx.db
    .update(merchantWallets)
    .set({ dailyLimit: limit })
    .where(
      and(
        eq(merchantWallets.merchantId, ctx.merchant.id),
        or(eq(merchantWallets.number, target), eq(merchantWallets.label, target))
      )
    )
    .returning();

  if (result.length === 0) {
    await ctx.reply(`⚠️ No wallet found matching "<code>${target}</code>".`, {
      parse_mode: 'HTML',
    });
    return;
  }

  await ctx.reply(
    `✅ Daily limit for <code>${result[0].number}</code> updated to ৳${limit.toLocaleString('en-BD')}.`,
    { parse_mode: 'HTML' }
  );
}

export async function handleWalletToggleCommand(ctx: BotContext, activate: boolean) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const target = parts[1];

  if (!target) {
    const cmd = activate ? '/wallet_resume' : '/wallet_pause';
    await ctx.reply(`⚠️ Usage: <code>${cmd} &lt;number or label&gt;</code>`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const result = await ctx.db
    .update(merchantWallets)
    .set({ active: activate ? 1 : 0 })
    .where(
      and(
        eq(merchantWallets.merchantId, ctx.merchant.id),
        or(eq(merchantWallets.number, target), eq(merchantWallets.label, target))
      )
    )
    .returning();

  if (result.length === 0) {
    await ctx.reply(`⚠️ No wallet found matching "<code>${target}</code>".`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const actionText = activate ? 'resumed and active' : 'paused';
  await ctx.reply(`✅ Wallet <code>${result[0].number}</code> is now ${actionText}.`, {
    parse_mode: 'HTML',
  });
}

export async function handleRotationCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const strategy = parts[1]?.toLowerCase();

  if (strategy !== 'balanced' && strategy !== 'fill_first') {
    await ctx.reply(
      '⚠️ Usage: <code>/rotation balanced</code> or <code>/rotation fill_first</code>\n\n• <b>balanced</b> (recommended): Evenly spreads payments across wallets with room.\n• <b>fill_first</b>: Fills highest priority wallet first up to its daily limit.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.db
    .update(merchants)
    .set({ rotationStrategy: strategy })
    .where(eq(merchants.id, ctx.merchant.id));

  await ctx.reply(`✅ Wallet rotation strategy set to: <code>${strategy}</code>`, {
    parse_mode: 'HTML',
  });
}
