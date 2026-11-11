import { and, eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchants, merchantWallets } from '../../db/schema';
import { generatePrefixedId } from '../../services/crypto';
import { renderSettingsDashboard, renderWalletsDashboard } from '../callbacks/menu';

const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

/**
 * Handles incoming text messages that are replies to interactive ForceReply prompts.
 */
export async function handleTextReply(ctx: BotContext) {
  if (!ctx.merchant) return;

  const replyText = ctx.message?.reply_to_message?.text;
  const input = ctx.message?.text?.trim();

  if (!replyText || !input) {
    return;
  }

  // 1. Adding bKash Wallet
  if (replyText.includes('Adding bKash Wallet')) {
    const parts = input.split(/\s+/);
    const number = parts[0];
    const label = parts.slice(1).join(' ') || undefined;

    if (!BD_PHONE_REGEX.test(number)) {
      await ctx.reply(
        '⚠️ Invalid phone number. Please enter a valid 11-digit Bangladeshi number starting with 013-019.',
        {
          reply_markup: { force_reply: true, input_field_placeholder: '017XXXXXXXX [label]' },
        }
      );
      return;
    }

    // Check duplicate
    const [existing] = await ctx.db
      .select()
      .from(merchantWallets)
      .where(
        and(
          eq(merchantWallets.merchantId, ctx.merchant.id),
          eq(merchantWallets.provider, 'bkash'),
          eq(merchantWallets.number, number)
        )
      )
      .limit(1);

    if (existing) {
      await ctx.reply(`⚠️ Wallet <code>${number}</code> is already registered under bKash.`, {
        parse_mode: 'HTML',
      });
      return renderWalletsDashboard(ctx);
    }

    const now = Math.floor(Date.now() / 1000);
    await ctx.db.insert(merchantWallets).values({
      id: generatePrefixedId('wal'),
      merchantId: ctx.merchant.id,
      provider: 'bkash',
      number,
      label: label ?? null,
      dailyLimit: 25000,
      priority: 100,
      active: 1,
      createdAt: now,
    });

    await ctx.reply(`✅ <b>bKash wallet ${number} added successfully!</b>`, {
      parse_mode: 'HTML',
    });
    return renderWalletsDashboard(ctx);
  }

  // 2. Adding Nagad Wallet
  if (replyText.includes('Adding Nagad Wallet')) {
    const parts = input.split(/\s+/);
    const number = parts[0];
    const label = parts.slice(1).join(' ') || undefined;

    if (!BD_PHONE_REGEX.test(number)) {
      await ctx.reply(
        '⚠️ Invalid phone number. Please enter a valid 11-digit Bangladeshi number starting with 013-019.',
        {
          reply_markup: { force_reply: true, input_field_placeholder: '018XXXXXXXX [label]' },
        }
      );
      return;
    }

    // Check duplicate
    const [existing] = await ctx.db
      .select()
      .from(merchantWallets)
      .where(
        and(
          eq(merchantWallets.merchantId, ctx.merchant.id),
          eq(merchantWallets.provider, 'nagad'),
          eq(merchantWallets.number, number)
        )
      )
      .limit(1);

    if (existing) {
      await ctx.reply(`⚠️ Wallet <code>${number}</code> is already registered under Nagad.`, {
        parse_mode: 'HTML',
      });
      return renderWalletsDashboard(ctx);
    }

    const now = Math.floor(Date.now() / 1000);
    await ctx.db.insert(merchantWallets).values({
      id: generatePrefixedId('wal'),
      merchantId: ctx.merchant.id,
      provider: 'nagad',
      number,
      label: label ?? null,
      dailyLimit: 25000,
      priority: 100,
      active: 1,
      createdAt: now,
    });

    await ctx.reply(`✅ <b>Nagad wallet ${number} added successfully!</b>`, {
      parse_mode: 'HTML',
    });
    return renderWalletsDashboard(ctx);
  }

  // 3. Edit Daily Limit
  if (replyText.includes('Edit Daily Limit')) {
    const match = replyText.match(/ID: (wal_[a-z0-9_]+)/);
    const walletId = match ? match[1] : undefined;
    const limit = parseInt(input.replace(/[^0-9]/g, ''), 10);

    if (!walletId || isNaN(limit) || limit < 1000) {
      await ctx.reply('⚠️ Please enter a valid amount (minimum ৳1,000):', {
        reply_markup: { force_reply: true, input_field_placeholder: '25000' },
      });
      return;
    }

    await ctx.db
      .update(merchantWallets)
      .set({ dailyLimit: limit })
      .where(
        and(
          eq(merchantWallets.id, walletId),
          eq(merchantWallets.merchantId, ctx.merchant.id)
        )
      );

    await ctx.reply(`✅ Daily limit updated to ৳${limit.toLocaleString('en-BD')}.`);
    return renderWalletsDashboard(ctx);
  }

  // 4. Set Store Name
  if (replyText.includes('Set Store Name')) {
    if (input.length > 50) {
      await ctx.reply('⚠️ Store name must be 50 characters or less. Please try again:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'My Brand Store' },
      });
      return;
    }

    await ctx.db
      .update(merchants)
      .set({ storeName: input })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.storeName = input;

    await ctx.reply(`✅ Store name updated to: <b>${input}</b>`, { parse_mode: 'HTML' });
    return renderSettingsDashboard(ctx);
  }

  // 5. Set Brand Color
  if (replyText.includes('Set Brand Color')) {
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input)) {
      await ctx.reply('⚠️ Invalid hex color code. Example format: #E11D48 or #000000:', {
        reply_markup: { force_reply: true, input_field_placeholder: '#E11D48' },
      });
      return;
    }

    await ctx.db
      .update(merchants)
      .set({ brandColor: input })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.brandColor = input;

    await ctx.reply(`✅ Brand color updated to: <code>${input}</code>`, { parse_mode: 'HTML' });
    return renderSettingsDashboard(ctx);
  }

  // 6. Set Webhook URL
  if (replyText.includes('Set Webhook URL')) {
    if (!input.startsWith('https://')) {
      await ctx.reply('⚠️ Webhook URL must use HTTPS. Please try again:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'https://...' },
      });
      return;
    }

    await ctx.db
      .update(merchants)
      .set({ webhookUrl: input })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.webhookUrl = input;

    await ctx.reply(`✅ Webhook URL saved to: <code>${input}</code>`, { parse_mode: 'HTML' });
    return renderSettingsDashboard(ctx);
  }
}
