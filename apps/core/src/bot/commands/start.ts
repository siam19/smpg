import type { BotContext } from '../context';
import { handleStartOnboarding } from '../handlers/onboarding';

export async function handleStartCommand(ctx: BotContext) {
  return handleStartOnboarding(ctx);
}
