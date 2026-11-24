#!/usr/bin/env bun
/**
 * SMPG Interactive Self-Hosted Setup & Deploy CLI
 *
 * Zero-dependency Bun script that provisions D1, configures apps/core/wrangler.toml,
 * applies migrations, uploads secrets, deploys the Worker, and registers the Telegram webhook.
 *
 * Usage: bun run setup
 */

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

const ROOT_DIR = resolve(import.meta.dir, '..');
const CORE_DIR = resolve(ROOT_DIR, 'apps/core');
const WRANGLER_TOML_PATH = resolve(CORE_DIR, 'wrangler.toml');

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

async function validateTelegramToken(token: string): Promise<TelegramBotInfo> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = (await res.json()) as { ok: boolean; result?: TelegramBotInfo; description?: string };
  if (!res.ok || !data.ok || !data.result) {
    throw new Error(data.description || `Telegram API returned HTTP ${res.status}`);
  }
  return data.result;
}

async function registerTelegramWebhook(
  token: string,
  workerUrl: string,
  webhookSecret: string
): Promise<void> {
  const webhookUrl = `${workerUrl.replace(/\/+$/, '')}/v1/telegram-webhook`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      drop_pending_updates: true,
    }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `setWebhook failed with HTTP ${res.status}`);
  }
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
  const res = await runCommand(['bunx', 'wrangler', 'secret', 'put', key], {
    stdinText: `${value}\n`,
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

  try {
    console.log('');
    console.log('=== SMPG Self-Hosted Setup ===');
    console.log('Deploys your private single-owner Cloudflare Worker + D1 instance.');
    console.log('');

    // Step 1: Check Wrangler auth
    console.log('[1/8] Checking Cloudflare Wrangler authentication...');
    let whoami = await runCommand(['bunx', 'wrangler', 'whoami']);
    if (whoami.exitCode !== 0 || /not authenticated|login/i.test(whoami.stdout + whoami.stderr)) {
      console.log('Wrangler is not authenticated.');
      const shouldLogin = (await rl.question('Run `bunx wrangler login` now? (Y/n): ')).trim().toLowerCase();
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
    console.log('');

    // Step 2: Telegram Bot Token + getMe validation
    console.log('[2/8] Telegram Bot Setup');
    console.log('  1. Open Telegram and message @BotFather');
    console.log('  2. Send /newbot and follow the prompts');
    console.log('  3. Paste the HTTP API token below');
    console.log('');

    let botToken = '';
    let botInfo: TelegramBotInfo | null = null;
    while (!botInfo) {
      botToken = (await rl.question('TELEGRAM_BOT_TOKEN: ')).trim();
      if (!botToken) {
        console.log('Bot token is required.');
        continue;
      }
      try {
        process.stdout.write('Validating bot token via Telegram getMe... ');
        botInfo = await validateTelegramToken(botToken);
        console.log(`OK (@${botInfo.username})`);
      } catch (err) {
        console.log(`FAILED (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    console.log('');

    // Step 3: Optional OWNER_TELEGRAM_ID or generated SETUP_TOKEN
    console.log('[3/8] Owner Access Control');
    console.log('  Enter your numeric Telegram user ID to lock the bot immediately,');
    console.log('  or press Enter to auto-generate a one-time /start claim link.');
    let ownerTelegramId = '';
    let setupToken = '';
    while (true) {
      const rawOwner = (await rl.question('OWNER_TELEGRAM_ID (optional): ')).trim();
      if (!rawOwner) {
        setupToken = randomBytes(16).toString('hex');
        console.log('Generated one-time 32-char SETUP_TOKEN for first-time claiming.');
        break;
      }
      if (/^\d+$/.test(rawOwner)) {
        ownerTelegramId = rawOwner;
        console.log(`Bot will be locked to Telegram ID ${ownerTelegramId}.`);
        break;
      }
      console.log('Please enter a numeric Telegram ID (digits only) or leave blank.');
    }
    console.log('');

    // Step 4: Worker name, D1 database, wrangler.toml, remote migrations
    console.log('[4/8] Cloudflare Worker & D1 Database');
    const workerName = await promptWithDefault(rl, 'Cloudflare Worker name', 'smpg-core');
    const dbName = await promptWithDefault(rl, 'Cloudflare D1 database name', 'smpg');

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
    console.log('');

    // Step 5: Deploy Worker first so it exists before uploading secrets
    console.log('[5/8] Deploying apps/core to Cloudflare Workers...');
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
        await rl.question('Enter the deployed Worker URL (e.g. https://smpg-core.<subdomain>.workers.dev): ')
      )
        .trim()
        .replace(/\/+$/, '');
    }
    if (!workerUrl.startsWith('https://')) {
      throw new Error(`Invalid Worker URL: "${workerUrl}"`);
    }
    console.log(`Deployed at: ${workerUrl}`);
    console.log('');

    // Step 6: Generate and upload secrets
    console.log('[6/8] Generating cryptographic secrets & uploading via Wrangler...');
    const encryptionKey = randomBytes(32).toString('hex');
    const webhookSecret = randomBytes(32).toString('hex');
    const botInfoJson = JSON.stringify(botInfo);

    const secrets: Array<[string, string]> = [
      ['TELEGRAM_BOT_TOKEN', botToken],
      ['TELEGRAM_WEBHOOK_SECRET', webhookSecret],
      ['ENCRYPTION_KEY', encryptionKey],
      ['BOT_INFO', botInfoJson],
    ];
    if (ownerTelegramId) {
      secrets.push(['OWNER_TELEGRAM_ID', ownerTelegramId]);
    } else {
      secrets.push(['SETUP_TOKEN', setupToken]);
    }

    for (const [key, value] of secrets) {
      process.stdout.write(`  Uploading ${key}... `);
      await putSecret(key, value);
      console.log('OK');
    }
    console.log('');

    // Step 7: Register Telegram webhook
    console.log('[7/8] Registering Telegram webhook...');
    await registerTelegramWebhook(botToken, workerUrl, webhookSecret);
    console.log(`Webhook set to: ${workerUrl}/v1/telegram-webhook`);
    console.log('');

    // Step 8: Summary
    console.log('[8/8] Setup complete!');
    console.log('');
    console.log('------------------------------------------------------------');
    console.log(`Worker URL (SMPG_CORE_URL): ${workerUrl}`);
    if (setupToken) {
      console.log(`Claim & Start Bot:          https://t.me/${botInfo.username}?start=${setupToken}`);
      console.log('');
      console.log('Note: Open the claim link above once to lock the bot to your Telegram account.');
    } else {
      console.log(`Open Your Bot:              https://t.me/${botInfo.username}`);
    }
    console.log('------------------------------------------------------------');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Open your Telegram bot link above and create your first store.');
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
  process.exit(1);
});
