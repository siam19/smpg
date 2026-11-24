import { Context } from 'grammy';
import type { Database } from '../db';
import type { BotConfig } from '../db/schema';
import type { Env } from '../types';

export interface BotContext extends Context {
  env: Env;
  db: Database;
  coreUrl?: string;
  ownerChatId: number | null;
  isOwner: boolean;
  botConfig: BotConfig | null;
}
