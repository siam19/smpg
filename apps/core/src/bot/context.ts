import { Context } from 'grammy';
import type { Database } from '../db';
import type { Merchant } from '../db/schema';
import type { Env } from '../types';

export interface BotContext extends Context {
  env: Env;
  db: Database;
  merchant?: Merchant | null;
}
