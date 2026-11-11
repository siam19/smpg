import { eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchants } from '../../db/schema';
import { decryptAesGcm } from '../../services/crypto';
import { renderSettingsDashboard } from '../callbacks/menu';

export async function handleSettingsCommand(ctx: BotContext) {
  return renderSettingsDashboard(ctx);
}

export async function handleStoreNameCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const name = parts.slice(1).join(' ').trim();

  if (!name) {
    await ctx.reply(
      '✏️ <b>Set Store Name</b>\n\nPlease reply with your new store or brand name (up to 50 characters):',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'My Brand Store' },
      }
    );
    return;
  }

  if (name.length > 50) {
    await ctx.reply('⚠️ Store name must be 50 characters or less.', { parse_mode: 'HTML' });
    return;
  }

  await ctx.db
    .update(merchants)
    .set({ storeName: name })
    .where(eq(merchants.id, ctx.merchant.id));
  ctx.merchant.storeName = name;

  await ctx.reply(`✅ Store name updated to: <b>${name}</b>`, { parse_mode: 'HTML' });
  return renderSettingsDashboard(ctx);
}

export async function handleBrandColorCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const color = parts[1]?.trim();

  if (!color) {
    await ctx.reply(
      '🎨 <b>Set Brand Color</b>\n\nPlease reply with a hex color code (e.g. #E11D48 or #10B981):',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '#E11D48' },
      }
    );
    return;
  }

  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    await ctx.reply('⚠️ Invalid hex color code. Example format: #E11D48 or #000000', {
      parse_mode: 'HTML',
    });
    return;
  }

  await ctx.db
    .update(merchants)
    .set({ brandColor: color })
    .where(eq(merchants.id, ctx.merchant.id));
  ctx.merchant.brandColor = color;

  await ctx.reply(`✅ Brand color updated to: <code>${color}</code>`, { parse_mode: 'HTML' });
  return renderSettingsDashboard(ctx);
}

export async function handleCodToggleCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const val = parts[1]?.toLowerCase();

  const nextCod = val ? (val === 'on' ? 1 : 0) : (ctx.merchant.codEnabled === 1 ? 0 : 1);
  await ctx.db
    .update(merchants)
    .set({ codEnabled: nextCod })
    .where(eq(merchants.id, ctx.merchant.id));
  ctx.merchant.codEnabled = nextCod;

  await ctx.reply(`✅ Cash on Delivery (COD) is now: <b>${nextCod ? 'ENABLED' : 'DISABLED'}</b>`, {
    parse_mode: 'HTML',
  });
  return renderSettingsDashboard(ctx);
}

export async function handleWebhookCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const url = parts[1]?.trim();

  if (!url) {
    await ctx.reply(
      '🔗 <b>Set Webhook URL</b>\n\nPlease reply with your HTTPS webhook endpoint URL:\n\n<b>Example:</b> <code>https://your-site.com/api/smpg-webhook</code>',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'https://...' },
      }
    );
    return;
  }

  if (!url.startsWith('https://')) {
    await ctx.reply('⚠️ Webhook URL must use HTTPS.', { parse_mode: 'HTML' });
    return;
  }

  // Update DB
  await ctx.db
    .update(merchants)
    .set({ webhookUrl: url })
    .where(eq(merchants.id, ctx.merchant.id));
  ctx.merchant.webhookUrl = url;

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
  return renderSettingsDashboard(ctx);
}

export async function handleHelpCommand(ctx: BotContext) {
  const helpText = [
    `📖 <b>SMPG Payments Bot Guide</b>`,
    '',
    `Use the interactive dashboards to manage your store without manual typing:`,
    '',
    `• /wallets - View wallets, daily usage bars, and add new bKash/Nagad accounts`,
    `• /settings - Store name, brand color, COD toggle, and webhooks`,
    `• /payments - View recent payments and reopen rejected ones`,
    `• /keys - View and rotate API keys`,
    '',
    `Every dashboard features clickable buttons for one-tap actions and clean prompt replies!`,
  ].join('\n');

  await ctx.reply(helpText, { parse_mode: 'HTML' });
}
