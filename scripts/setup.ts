#!/usr/bin/env bun
/**
 * SMPG Interactive Self-Hosted Setup & Deploy CLI
 *
 * Zero-dependency Bun script that provisions D1, configures apps/core/wrangler.toml,
 * applies migrations, deploys the Worker, uploads secrets, and registers the Telegram
 * webhook from Cloudflare's edge. Automatically resumes from the last successful step
 * if interrupted or re-run.
 *
 * Usage:
 *   bun run setup            # Run or resume setup
 *   bun run setup -- --reset # Discard saved progress and start fresh
 */

import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

const ROOT_DIR = resolve(import.meta.dir, '..');
const CORE_DIR = resolve(ROOT_DIR, 'apps/core');
const WRANGLER_TOML_PATH = resolve(CORE_DIR, 'wrangler.toml');
const STATE_PATH = resolve(ROOT_DIR, '.smpg-setup-state.json');

type StepId = 'auth' | 'config' | 'd1' | 'deploy' | 'secrets' | 'webhook';

interface SetupState {
  completedSteps: StepId[];
  botToken?: string;
  ownerTelegramId?: string;
  workerName?: string;
  dbName?: string;
  databaseId?: string;
  workerUrl?: string;
  encryptionKey?: string;
  webhookSecret?: string;
  botUsername?: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{20,}$/;

async function loadState(): Promise<SetupState | null> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SetupState;
    if (Array.isArray(parsed.completedSteps)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveState(state: SetupState): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

async function clearState(): Promise<void> {
  try {
    await rm(STATE_PATH, { force: true });
  } catch {
    // Ignore if absent
  }
}

function isStepDone(state: SetupState, step: StepId): boolean {
  return state.completedSteps.includes(step);
}

async function markStepDone(state: SetupState, step: StepId): Promise<void> {
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
  }
  await saveState(state);
}

async function runCommand(
  cmd: string[],
  options: { cwd?: string; stdinText?: string; inheritStdio?: boolean } = {}
): Promise<CommandResult> {
  if (options.inheritStdio) {
    const proc = Bun.spawn(cmd, {
      cwd: options.cwd ?? CORE_DIR,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    return { exitCode, stdout: '', stderr: '' };
  }

  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? CORE_DIR,
    stdin: options.stdinText !== undefined ? new Response(options.stdinText) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function registerWebhookViaWorker(
  workerUrl: string,
  webhookSecret: string
): Promise<{ webhookUrl: string; bot: TelegramBotInfo | null }> {
  const registerUrl = `${workerUrl.replace(/\/+$/, '')}/v1/telegram-webhook/register`;

  let authRetries = 0;
  let rateLimitRetries = 0;
  let lastError = 'Unknown error';

  while (true) {
    try {
      const res = await fetch(registerUrl, {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
        },
      });
      const data = (await res.json()) as {
        ok: boolean;
        webhook_url?: string;
        bot?: TelegramBotInfo | null;
        error?: string;
        retry_after?: number;
      };

      if (res.ok && data.ok) {
        return {
          webhookUrl: data.webhook_url || `${workerUrl.replace(/\/+$/, '')}/v1/telegram-webhook`,
          bot: data.bot ?? null,
        };
      }

      lastError = data.error || `HTTP ${res.status}`;

      // 1. Secret propagation delay right after `wrangler secret put`
      if (res.status === 401 && authRetries < 6) {
        authRetries++;
        console.log(`  Waiting for Cloudflare Worker secret propagation (attempt ${authRetries}/6)...`);
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }

      // 2. Telegram per-bot 429 rate limit: ALWAYS wait the full retry_after + 2s (never hammer!)
      const retryAfterMatch = lastError.match(/retry after\s+(\d+)/i);
      const retryAfterSec =
        typeof data.retry_after === 'number'
          ? data.retry_after
          : retryAfterMatch
            ? parseInt(retryAfterMatch[1], 10)
            : null;

      if ((res.status === 429 || retryAfterSec !== null) && rateLimitRetries < 3) {
        rateLimitRetries++;
        const waitSec = Math.min((retryAfterSec ?? 20) + 2, 65);
        console.log(
          `  Telegram rate-limited this bot (${lastError}). Waiting ${waitSec}s before retrying (${rateLimitRetries}/3)...`
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (authRetries < 3) {
        authRetries++;
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      break;
    }
  }

  throw new Error(
    `Worker webhook registration failed: ${lastError}\n` +
      `  Tip: If Telegram keeps returning 429 for this bot token, make sure no other app is polling it,\n` +
      `  or rotate/create a fresh bot token via @BotFather (/revoke or /newbot) and run \`bun run setup -- --reset\`.`
  );
}

async function findExistingD1DatabaseId(dbName: string): Promise<string | null> {
  const res = await runCommand(['bunx', 'wrangler', 'd1', 'list', '--json']);
  if (res.exitCode !== 0) return null;

  try {
    const list = JSON.parse(res.stdout) as Array<{ name?: string; uuid?: string }>;
    const match = list.find((db) => db.name === dbName && typeof db.uuid === 'string');
    return match?.uuid ?? null;
  } catch {
    return null;
  }
}

function parseDatabaseId(outputText: string): string | null {
  const tomlMatch = outputText.match(/database_id\s*=\s*"([0-9a-fA-F-]{36})"/);
  if (tomlMatch?.[1]) return tomlMatch[1];

  const jsonMatch = outputText.match(/"database_id"\s*:\s*"([0-9a-fA-F-]{36})"/);
  if (jsonMatch?.[1]) return jsonMatch[1];

  const uuidMatch = outputText.match(/uuid["']?\s*[:=]\s*["']?([0-9a-fA-F-]{36})/i);
  if (uuidMatch?.[1]) return uuidMatch[1];

  return null;
}

function parseWorkerUrl(outputText: string): string | null {
  const match = outputText.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return match?.[0] ?? null;
}

function buildWranglerToml(workerName: string, dbName: string, databaseId: string): string {
  return [
    `name = "${workerName}"`,
    `main = "src/index.ts"`,
    `compatibility_date = "2024-11-01"`,
    `compatibility_flags = ["nodejs_compat"]`,
    ``,
    `[vars]`,
    `UNDO_WINDOW_SECONDS = "90"`,
    `SUBMITTED_TTL_HOURS = "72"`,
    `CREATED_TTL_MINUTES = "60"`,
    `LATE_SUBMIT_HOURS = "24"`,
    ``,
    `[[d1_databases]]`,
    `binding = "DB"`,
    `database_name = "${dbName}"`,
    `database_id = "${databaseId}"`,
    `migrations_dir = "migrations"`,
    ``,
    `[triggers]`,
    `crons = ["* * * * *"]`,
    ``,
  ].join('\n');
}

async function putSecret(key: string, value: string): Promise<void> {
  // Pass exact trimmed value WITHOUT trailing newline so Wrangler doesn't store "\n" in the secret
  const res = await runCommand(['bunx', 'wrangler', 'secret', 'put', key], {
    stdinText: value.trim(),
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to upload secret ${key}: ${(res.stderr || res.stdout).trim() || `exit code ${res.exitCode}`}`
    );
  }
}

async function promptWithDefault(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string
): Promise<string> {
  const answer = (await rl.question(`${label} [${defaultValue}]: `)).trim();
  return answer || defaultValue;
}

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  const forceReset = process.argv.includes('--reset');

  try {
    console.log('');
    console.log('=== SMPG Self-Hosted Setup ===');
    console.log('Deploys your private single-owner Cloudflare Worker + D1 instance.');
    console.log('');

    let state: SetupState = { completedSteps: [] };
    if (forceReset) {
      await clearState();
      console.log('Cleared previous setup state (--reset). Starting fresh.\n');
    } else {
      const existing = await loadState();
      if (existing && existing.completedSteps.length > 0) {
        console.log(
          `Found saved setup progress (completed: ${existing.completedSteps.join(', ')}).`
        );
        const resumeAns = (
          await rl.question('Resume from last successful step? (Y/n): ')
        )
          .trim()
          .toLowerCase();
        if (resumeAns === 'n' || resumeAns === 'no') {
          await clearState();
          console.log('Starting fresh.\n');
        } else {
          state = existing;
          console.log('Resuming setup...\n');
        }
      }
    }

    // Step 1: Check Wrangler auth
    if (isStepDone(state, 'auth')) {
      console.log('[1/7] Cloudflare Wrangler authentication — already completed, skipping.');
    } else {
      console.log('[1/7] Checking Cloudflare Wrangler authentication...');
      let whoami = await runCommand(['bunx', 'wrangler', 'whoami']);
      if (whoami.exitCode !== 0 || /not authenticated|login/i.test(whoami.stdout + whoami.stderr)) {
        console.log('Wrangler is not authenticated.');
        const shouldLogin = (await rl.question('Run `bunx wrangler login` now? (Y/n): '))
          .trim()
          .toLowerCase();
        if (shouldLogin === 'n' || shouldLogin === 'no') {
          console.log('Please run `bunx wrangler login` and re-run `bun run setup`.');
          process.exit(1);
        }
        const loginRes = await runCommand(['bunx', 'wrangler', 'login'], { inheritStdio: true });
        if (loginRes.exitCode !== 0) {
          throw new Error('Wrangler login failed. Please authenticate and try again.');
        }
        whoami = await runCommand(['bunx', 'wrangler', 'whoami']);
        if (whoami.exitCode !== 0) {
          throw new Error('Unable to verify Wrangler authentication after login.');
        }
      }
      console.log('Cloudflare account authenticated.');
      await markStepDone(state, 'auth');
    }
    console.log('');

    // Step 2: Telegram Bot Token & Owner Access Control
    if (isStepDone(state, 'config') && state.botToken) {
      console.log('[2/7] Telegram Bot & Owner Config — already completed, skipping.');
    } else {
      console.log('[2/7] Telegram Bot Setup');
      console.log('  1. Open Telegram and message @BotFather');
      console.log('  2. Send /newbot and follow the prompts');
      console.log('  3. Paste the HTTP API token below');
      console.log('');

      while (true) {
        const token = (await rl.question('TELEGRAM_BOT_TOKEN: ')).trim();
        if (!token) {
          console.log('Bot token is required.');
          continue;
        }
        if (!BOT_TOKEN_REGEX.test(token)) {
          console.log(
            'Invalid token format. Expected something like 123456789:ABCdef... from @BotFather.'
          );
          continue;
        }
        state.botToken = token;
        break;
      }
      console.log('');

      console.log('Owner Access Control:');
      console.log('  Enter your numeric Telegram user ID to pre-lock the bot,');
      console.log('  or press Enter to claim ownership automatically on your first /start.');
      while (true) {
        const rawOwner = (await rl.question('OWNER_TELEGRAM_ID (optional): ')).trim();
        if (!rawOwner) {
          state.ownerTelegramId = '';
          console.log('Ownership will lock automatically to the first account that sends /start.');
          break;
        }
        if (/^\d+$/.test(rawOwner)) {
          state.ownerTelegramId = rawOwner;
          console.log(`Bot will be locked to Telegram ID ${rawOwner}.`);
          break;
        }
        console.log('Please enter a numeric Telegram ID (digits only) or leave blank.');
      }

      await markStepDone(state, 'config');
    }
    console.log('');

    // Step 3: D1 Database, wrangler.toml, and remote migrations
    if (isStepDone(state, 'd1') && state.workerName && state.dbName && state.databaseId) {
      console.log(
        `[3/7] D1 Database & Migrations (${state.dbName}) — already completed, skipping.`
      );
    } else {
      console.log('[3/7] Cloudflare Worker & D1 Database');
      const workerName = await promptWithDefault(
        rl,
        'Cloudflare Worker name',
        state.workerName || 'smpg-core'
      );
      const dbName = await promptWithDefault(
        rl,
        'Cloudflare D1 database name',
        state.dbName || 'smpg'
      );

      console.log(`Provisioning D1 database "${dbName}"...`);
      const createDbRes = await runCommand(['bunx', 'wrangler', 'd1', 'create', dbName]);
      let databaseId = parseDatabaseId(createDbRes.stdout + '\n' + createDbRes.stderr);

      if (!databaseId) {
        const combined = `${createDbRes.stdout}\n${createDbRes.stderr}`;
        if (/already exists/i.test(combined)) {
          console.log(`D1 database "${dbName}" already exists. Looking up database_id...`);
          databaseId = await findExistingD1DatabaseId(dbName);
        }
      }

      if (!databaseId) {
        console.log('Could not automatically parse database_id from Wrangler output.');
        const manualId = (await rl.question('Paste your D1 database_id (UUID): ')).trim();
        if (!/^[0-9a-fA-F-]{36}$/.test(manualId)) {
          throw new Error('Invalid D1 database_id.');
        }
        databaseId = manualId;
      }

      console.log(`Using D1 database_id: ${databaseId}`);
      const wranglerToml = buildWranglerToml(workerName, dbName, databaseId);
      await writeFile(WRANGLER_TOML_PATH, wranglerToml, 'utf-8');
      console.log('Wrote apps/core/wrangler.toml');

      console.log('Applying D1 migrations remotely...');
      const migrateRes = await runCommand(
        ['bunx', 'wrangler', 'd1', 'migrations', 'apply', dbName, '--remote'],
        { stdinText: 'y\n' }
      );
      if (migrateRes.exitCode !== 0) {
        throw new Error(
          `Failed to apply D1 migrations:\n${(migrateRes.stderr || migrateRes.stdout).trim()}`
        );
      }
      console.log('D1 migrations applied.');

      state.workerName = workerName;
      state.dbName = dbName;
      state.databaseId = databaseId;
      await markStepDone(state, 'd1');
    }
    console.log('');

    // Step 4: Deploy Worker first so it exists before uploading secrets
    if (isStepDone(state, 'deploy') && state.workerUrl) {
      console.log(`[4/7] Worker Deploy (${state.workerUrl}) — already completed, skipping.`);
    } else {
      console.log('[4/7] Deploying apps/core to Cloudflare Workers...');
      const deployRes = await runCommand(['bunx', 'wrangler', 'deploy']);
      if (deployRes.exitCode !== 0) {
        throw new Error(
          `Wrangler deploy failed:\n${(deployRes.stderr || deployRes.stdout).trim()}`
        );
      }

      let workerUrl = parseWorkerUrl(deployRes.stdout + '\n' + deployRes.stderr);
      if (!workerUrl) {
        console.log(deployRes.stdout.trim());
        workerUrl = (
          await rl.question(
            'Enter the deployed Worker URL (e.g. https://smpg-core.<subdomain>.workers.dev): '
          )
        )
          .trim()
          .replace(/\/+$/, '');
      }
      if (!workerUrl.startsWith('https://')) {
        throw new Error(`Invalid Worker URL: "${workerUrl}"`);
      }
      console.log(`Deployed at: ${workerUrl}`);

      state.workerUrl = workerUrl;
      await markStepDone(state, 'deploy');
    }
    console.log('');

    // Step 5: Generate and upload secrets
    if (isStepDone(state, 'secrets') && state.webhookSecret && state.encryptionKey) {
      console.log('[5/7] Worker Secrets — already uploaded, skipping.');
    } else {
      console.log('[5/7] Generating cryptographic secrets & uploading via Wrangler...');
      const encryptionKey = state.encryptionKey || randomBytes(32).toString('hex');
      const webhookSecret = state.webhookSecret || randomBytes(32).toString('hex');

      const secrets: Array<[string, string]> = [
        ['TELEGRAM_BOT_TOKEN', state.botToken!],
        ['TELEGRAM_WEBHOOK_SECRET', webhookSecret],
        ['ENCRYPTION_KEY', encryptionKey],
      ];
      if (state.ownerTelegramId) {
        secrets.push(['OWNER_TELEGRAM_ID', state.ownerTelegramId]);
      }

      for (const [key, value] of secrets) {
        process.stdout.write(`  Uploading ${key}... `);
        await putSecret(key, value);
        console.log('OK');
      }

      state.encryptionKey = encryptionKey;
      state.webhookSecret = webhookSecret;
      await markStepDone(state, 'secrets');
    }
    console.log('');

    // Step 6: Register Telegram webhook via the deployed Cloudflare Worker (avoids local ISP 429s)
    if (isStepDone(state, 'webhook')) {
      console.log('[6/7] Telegram Webhook Registration — already completed, skipping.');
    } else {
      console.log('[6/7] Registering Telegram webhook via Cloudflare edge...');
      const { webhookUrl, bot } = await registerWebhookViaWorker(
        state.workerUrl!,
        state.webhookSecret!
      );
      console.log(`Webhook set to: ${webhookUrl}`);
      if (bot) {
        state.botUsername = bot.username;
        console.log(`Verified bot: @${bot.username}`);
        process.stdout.write('  Caching BOT_INFO secret... ');
        await putSecret('BOT_INFO', JSON.stringify(bot));
        console.log('OK');
      }
      await markStepDone(state, 'webhook');
    }
    console.log('');

    // Step 7: Cleanup temporary state file & print summary
    const finalWorkerUrl = state.workerUrl!;
    const finalBotUsername = state.botUsername;
    await clearState();

    console.log('[7/7] Setup complete!');
    console.log('');
    console.log('------------------------------------------------------------');
    console.log(`Worker URL (SMPG_CORE_URL): ${finalWorkerUrl}`);
    if (finalBotUsername) {
      console.log(`Open Your Bot:              https://t.me/${finalBotUsername}`);
    } else {
      console.log('Open your bot in Telegram and tap Start.');
    }
    console.log('------------------------------------------------------------');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Open your Telegram bot and tap Start to claim ownership & create your first store.');
    console.log('  2. Add your personal bKash / Nagad wallets via /wallets.');
    console.log('  3. Copy your store API key (smpg_live_... / smpg_test_...) and webhook secret into your storefront.');
    console.log('');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('');
  console.error('Setup failed:', err instanceof Error ? err.message : String(err));
  console.error('Progress was saved. Fix the issue and re-run `bun run setup` to resume.');
  process.exit(1);
});
