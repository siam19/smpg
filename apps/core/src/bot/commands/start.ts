import { eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { botConfig, stores } from '../../db/schema';
import { ACCESS_DENIED_MESSAGE } from '../middleware/auth';
import { renderMainMenu } from '../callbacks/menu';

/**
 * Prompts the verified owner to create their first store via ForceReply.
 */
async function promptFirstStoreCreation(ctx: BotContext, headerNote?: string) {
  const lines: string[] = [];
  if (headerNote) {
    lines.push(headerNote, '');
  }
  lines.push(
    '<b>Create New Store</b>',
    '',
    'You have no stores configured yet. Reply to this message with your first store name (up to 50 characters):',
    '',
    '<b>Example:</b> <code>My Shop</code>'
  );

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: 'My Shop',
    },
  });
}

/**
 * Handles /start [setup_token]:
 * - If already claimed by someone else (or OWNER_TELEGRAM_ID mismatch): reject with zero DB writes.
 * - If unclaimed: verify SETUP_TOKEN (if configured) and claim ownership in bot_config.
 * - For the verified owner: prompt to create first store if none exist, otherwise show Main Menu.
 */
export async function handleStartCommand(ctx: BotContext) {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? null;

  if (!ctx.isOwner) {
    // Already claimed by another user or locked to a different OWNER_TELEGRAM_ID
    if (ctx.ownerChatId !== null || chatId === null) {
      await ctx.reply(ACCESS_DENIED_MESSAGE);
      return;
    }

    // Bot is currently unclaimed: validate SETUP_TOKEN if set
    const requiredToken = ctx.env.SETUP_TOKEN?.trim();
    if (requiredToken) {
      const text = ctx.message?.text?.trim() || '';
      const parts = text.split(/\s+/);
      const providedToken = parts[1]?.trim();

      if (!providedToken || providedToken !== requiredToken) {
        await ctx.reply(ACCESS_DENIED_MESSAGE);
        return;
      }
    }

    // Claim ownership in bot_config (singleton row id = 'default')
    const now = Math.floor(Date.now() / 1000);
    if (ctx.botConfig) {
      await ctx.db
        .update(botConfig)
        .set({
          ownerTelegramChatId: chatId,
          updatedAt: now,
        })
        .where(eq(botConfig.id, ctx.botConfig.id));
      ctx.botConfig = {
        ...ctx.botConfig,
        ownerTelegramChatId: chatId,
        updatedAt: now,
      };
    } else {
      const newConfig = {
        id: 'default',
        ownerTelegramChatId: chatId,
        rotationStrategy: 'balanced',
        createdAt: now,
        updatedAt: now,
      };
      await ctx.db.insert(botConfig).values(newConfig);
      ctx.botConfig = newConfig;
    }

    ctx.ownerChatId = chatId;
    ctx.isOwner = true;

    const existingStores = await ctx.db.select().from(stores).limit(1);
    if (existingStores.length === 0) {
      await promptFirstStoreCreation(
        ctx,
        '<b>Ownership Claimed</b>\nThis SMPG bot is now locked to your Telegram account.'
      );
      return;
    }

    await ctx.reply(
      '<b>Ownership Claimed</b>\nThis SMPG bot is now locked to your Telegram account.',
      { parse_mode: 'HTML' }
    );
    return renderMainMenu(ctx);
  }

  // Verified owner
  const existingStores = await ctx.db.select().from(stores).limit(1);
  if (existingStores.length === 0) {
    await promptFirstStoreCreation(ctx, '<b>Welcome to SMPG</b>');
    return;
  }

  return renderMainMenu(ctx);
}
