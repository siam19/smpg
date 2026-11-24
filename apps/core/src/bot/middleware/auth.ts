import { eq } from 'drizzle-orm';
import type { NextFunction } from 'grammy';
import type { BotContext } from '../context';
import { botConfig } from '../../db/schema';

export const ACCESS_DENIED_MESSAGE = 'Access denied. This is a private SMPG bot.';

/**
 * Resolves single-owner authorization from OWNER_TELEGRAM_ID env var or bot_config.
 * Never performs DB writes for unauthorized users.
 */
export async function authMiddleware(ctx: BotContext, next: NextFunction) {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? null;

  let config =
    (await ctx.db
      .select()
      .from(botConfig)
      .where(eq(botConfig.id, 'default'))
      .limit(1)
      .get()) ?? null;

  const envOwnerRaw = ctx.env.OWNER_TELEGRAM_ID?.trim();
  const parsedEnvOwner = envOwnerRaw ? parseInt(envOwnerRaw, 10) : NaN;

  if (Number.isFinite(parsedEnvOwner) && parsedEnvOwner > 0) {
    ctx.ownerChatId = parsedEnvOwner;
    ctx.isOwner = chatId !== null && chatId === parsedEnvOwner;

    // Auto-sync bot_config only when the verified owner interacts
    if (ctx.isOwner) {
      const now = Math.floor(Date.now() / 1000);
      if (!config) {
        await ctx.db.insert(botConfig).values({
          id: 'default',
          ownerTelegramChatId: parsedEnvOwner,
          rotationStrategy: 'balanced',
          createdAt: now,
          updatedAt: now,
        });
        config = {
          id: 'default',
          ownerTelegramChatId: parsedEnvOwner,
          rotationStrategy: 'balanced',
          createdAt: now,
          updatedAt: now,
        };
      } else if (config.ownerTelegramChatId !== parsedEnvOwner) {
        await ctx.db
          .update(botConfig)
          .set({
            ownerTelegramChatId: parsedEnvOwner,
            updatedAt: now,
          })
          .where(eq(botConfig.id, 'default'));
        config = {
          ...config,
          ownerTelegramChatId: parsedEnvOwner,
          updatedAt: now,
        };
      }
    }
  } else {
    ctx.ownerChatId = config?.ownerTelegramChatId ?? null;
    ctx.isOwner = chatId !== null && ctx.ownerChatId !== null && chatId === ctx.ownerChatId;
  }

  ctx.botConfig = config;
  await next();
}

/**
 * Guard middleware strictly rejecting any non-owner Telegram user with zero DB writes.
 */
export async function requireOwner(ctx: BotContext, next: NextFunction) {
  if (!ctx.isOwner) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: ACCESS_DENIED_MESSAGE,
        show_alert: true,
      });
    } else {
      await ctx.reply(ACCESS_DENIED_MESSAGE);
    }
    return;
  }

  await next();
}
