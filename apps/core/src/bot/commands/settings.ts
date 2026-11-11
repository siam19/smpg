import { eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchants } from '../../db/schema';
import { decryptAesGcm } from '../../services/crypto';

export async function handleStoreNameCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const name = parts.slice(1).join(' ').trim();

  if (!name || name.length > 50) {
    await ctx.reply('⚠️ Usage: <code>/store_name &lt;Store Name (up to 50 chars)&gt;</code>', {
      parse_mode: 'HTML',
    });
    return;
  }

  await ctx.db
    .update(merchants)
    .set({ storeName: name })
    .where(eq(merchants.id, ctx.merchant.id));

  await ctx.reply(`✅ Store name updated to: <b>${name}</b>`, { parse_mode: 'HTML' });
}

export async function handleBrandColorCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const color = parts[1]?.trim();

  if (!color || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    await ctx.reply(
      '⚠️ Usage: <code>/brand_color &lt;#hexcode&gt;</code>\nExample: <code>/brand_color #E11D48</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.db
    .update(merchants)
    .set({ brandColor: color })
    .where(eq(merchants.id, ctx.merchant.id));

  await ctx.reply(`✅ Brand color updated to: <code>${color}</code>`, { parse_mode: 'HTML' });
}

export async function handleCodToggleCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const val = parts[1]?.toLowerCase();

  if (val !== 'on' && val !== 'off') {
    await ctx.reply('⚠️ Usage: <code>/cod on</code> or <code>/cod off</code>', {
      parse_mode: 'HTML',
    });
    return;
  }

  const enabled = val === 'on' ? 1 : 0;
  await ctx.db
    .update(merchants)
    .set({ codEnabled: enabled })
    .where(eq(merchants.id, ctx.merchant.id));

  await ctx.reply(`✅ Cash on Delivery (COD) is now: <b>${val.toUpperCase()}</b>`, {
    parse_mode: 'HTML',
  });
}

export async function handleWebhookCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const url = parts[1]?.trim();

  if (!url || !url.startsWith('https://')) {
    await ctx.reply(
      '⚠️ Usage: <code>/webhook &lt;https://your-domain.com/webhook&gt;</code>\nNote: Must use HTTPS.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Update DB
  await ctx.db
    .update(merchants)
    .set({ webhookUrl: url })
    .where(eq(merchants.id, ctx.merchant.id));

  // Dispatch a test ping
  let pingResult = 'Sent test ping';
  try {
    const rawSecret = await decryptAesGcm(ctx.merchant.webhookSecret, ctx.env.ENCRYPTION_KEY);
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: 'evt_test_ping',
      type: 'payment.created',
      created: timestamp,
      data: {
        id: 'pay_test_ping',
        amount: 100,
        status: 'CREATED',
        method: 'bkash',
        test: true,
      },
    });

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(rawSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`));
    const sigHex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': `t=${timestamp},v1=${sigHex}`,
        'x-smpg-event': 'payment.created',
      },
      body: payload,
    });

    if (res.ok) {
      pingResult = `🟢 Test ping succeeded (HTTP ${res.status})`;
    } else {
      pingResult = `🟡 Test ping returned HTTP ${res.status}`;
    }
  } catch (err: any) {
    pingResult = `🔴 Test ping failed: ${err.message}`;
  }

  await ctx.reply(
    `✅ <b>Webhook URL saved!</b>\nURL: <code>${url}</code>\n\n${pingResult}`,
    { parse_mode: 'HTML' }
  );
}

export async function handleHelpCommand(ctx: BotContext) {
  const helpText = [
    `📖 <b>SMPG Payments Bot Guide</b>`,
    '',
    `<b>Wallet Management:</b>`,
    `• /wallets - View all wallets and daily capacity`,
    `• /add_bkash &lt;number&gt; [label] - Add bKash account`,
    `• /add_nagad &lt;number&gt; [label] - Add Nagad account`,
    `• /wallet_limit &lt;target&gt; &lt;amount&gt; - Set daily limit`,
    `• /wallet_pause &lt;target&gt; - Pause wallet`,
    `• /wallet_resume &lt;target&gt; - Resume wallet`,
    `• /rotation balanced|fill_first - Wallet rotation mode`,
    '',
    `<b>Store Settings:</b>`,
    `• /store_name &lt;name&gt; - Set customer-facing brand name`,
    `• /brand_color &lt;#hex&gt; - Checkout theme color`,
    `• /cod on|off - Toggle Cash on Delivery`,
    `• /webhook &lt;url&gt; - Set outbound webhook URL`,
    '',
    `<b>Transactions & Keys:</b>`,
    `• /payments - View 10 most recent transactions`,
    `• /reopen &lt;payment_id&gt; - Reopen rejected payment (within 7d)`,
    `• /keys - Show API key prefixes`,
    `• /keys rotate live|test - Rotate API keys`,
    `• /pause & /resume - Global store pause/resume`,
  ].join('\n');

  await ctx.reply(helpText, { parse_mode: 'HTML' });
}
