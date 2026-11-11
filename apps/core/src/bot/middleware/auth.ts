import { eq } from 'drizzle-orm';
import type { NextFunction } from 'grammy';
import type { BotContext } from '../context';
import { merchants } from '../../db/schema';

export async function authMiddleware(ctx: BotContext, next: NextFunction) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;

  if (chatId) {
    const [merchant] = await ctx.db
      .select()
      .from(merchants)
      .where(eq(merchants.telegramChatId, chatId))
      .limit(1);

    ctx.merchant = merchant ?? null;
  }

  await next();
}

/**
 * Guard middleware requiring an active registered merchant.
 */
export async function requireMerchant(ctx: BotContext, next: NextFunction) {
  if (!ctx.merchant) {
    await ctx.reply(
      '👋 You are not registered yet as a merchant.\n\nType /start to register your store and get your API keys.'
    );
    return;
  }

  if (ctx.merchant.onboardingStep && ctx.merchant.onboardingStep !== 'completed') {
    await ctx.reply(
      '⚠️ Please complete your account onboarding first! Type /start to resume.'
    );
    return;
  }

  await next();
}
