#!/usr/bin/env bun
/**
 * SMPG Interactive Self-Hosted Setup & Deploy CLI
 *
 * Stylized interactive wizard powered by @clack/prompts & picocolors.
 * Provisions D1, writes apps/core/wrangler.toml, applies migrations, deploys
 * the Cloudflare Worker, uploads encrypted secrets, and registers the Telegram
 * webhook from Cloudflare's edge. Automatically saves progress so interrupted
 * runs resume from the last successful step.
 *
 * Usage:
 *   bun run setup            # Run or resume setup
 *   bun run setup -- --reset # Discard saved progress and start fresh
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import color from 'picocolors';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIR = resolve(ROOT_DIR, 'apps/core');
const WRANGLER_TOML_PATH = resolve(CORE_DIR, 'wrangler.toml');
const STATE_PATH = resolve(ROOT_DIR, '.smpg-setup-state.json');

type StepId = 'auth' | 'config' | 'd1' | 'deploy' | 'secrets' | 'webhook';

const ALL_STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'auth', label: 'Cloudflare authentication' },
  { id: 'config', label: 'Telegram bot & owner config' },
  { id: 'd1', label: 'D1 database & migrations' },
  { id: 'deploy', label: 'Cloudflare Worker deploy' },
  { id: 'secrets', label: 'Worker secrets upload' },
  { id: 'webhook', label: 'Telegram webhook registration' },
];

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
const WORKER_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function unwrapPrompt<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel('Setup paused. Completed steps are saved — run `bun run setup` anytime to resume.');
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

function renderBanner(): void {
  const art = [
    '  ███████╗███╗   ███╗██████╗  ██████╗ ',
    '  ██╔════╝████╗ ████║██╔══██╗██╔════╝ ',
    '  ███████╗██╔████╔██║██████╔╝██║  ███╗',
    '  ╚════██║██║╚██╔╝██║██╔═══╝ ██║   ██║',
    '  ███████║██║ ╚═╝ ██║██║     ╚██████╔╝',
    '  ╚══════╝╚═╝     ╚═╝╚═╝      ╚═════╝ ',
  ];

  console.log('');
  for (const line of art) {
    console.log(color.cyan(line));
  }
  console.log(
    `  ${color.dim('Send Money Payment Gateway')}  ${color.dim('·')}  ${color.green('0% Fees')}  ${color.dim('·')}  ${color.yellow('Self-Hosted')}`
  );
  console.log('');
}

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
  const [binary, ...args] = cmd;
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(binary, args, {
      cwd: options.cwd ?? CORE_DIR,
      stdio: options.inheritStdio
        ? 'inherit'
        : [options.stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (!options.inheritStdio) {
      proc.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      if (options.stdinText !== undefined && proc.stdin) {
        proc.stdin.write(options.stdinText);
        proc.stdin.end();
      }
    }

    proc.on('error', rejectPromise);
    proc.on('close', (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function parseCloudflareAccount(whoamiOutput: string): string | null {
  const emailMatch = whoamiOutput.match(/associated with the email\s+([^\s.]+@[^\s.!]+)/i);
  if (emailMatch?.[1]) return emailMatch[1];

  const genericEmail = whoamiOutput.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return genericEmail?.[0] ?? null;
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

async function countdownSpinner(
  s: p.SpinnerResult,
  seconds: number,
  buildMessage: (remaining: number) => string
): Promise<void> {
  for (let remaining = seconds; remaining > 0; remaining--) {
    s.message(buildMessage(remaining));
    await sleep(1000);
  }
}

async function registerWebhookViaWorker(
  workerUrl: string,
  webhookSecret: string,
  s: p.SpinnerResult
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
        s.message(
          `Waiting for Cloudflare secret propagation ${color.dim(`(attempt ${authRetries}/6)`)}`
        );
        await sleep(2500);
        continue;
      }

      // 2. Telegram per-bot 429 rate limit: ALWAYS wait the full retry_after + 2s with live countdown
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
        await countdownSpinner(
          s,
          waitSec,
          (rem) =>
            `${color.yellow('Telegram rate limit (429)')} — retrying in ${color.bold(`${rem}s`)} ${color.dim(`(${rateLimitRetries}/3)`)}`
        );
        s.message('Retrying webhook registration from Cloudflare edge...');
        continue;
      }

      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (authRetries < 3) {
        authRetries++;
        s.message(`Retrying edge request ${color.dim(`(attempt ${authRetries}/3)`)}`);
        await sleep(2500);
        continue;
      }
      break;
    }
  }

  throw new Error(lastError);
}

async function main(): Promise<void> {
  const forceReset = process.argv.includes('--reset');

  renderBanner();
  p.intro(color.bgCyan(color.black(' smpg · self-hosted setup ')));

  // Load or reset saved progress
  let state: SetupState = { completedSteps: [] };
  if (forceReset) {
    await clearState();
    p.log.info(`Cleared saved setup progress ${color.dim('(--reset)')}. Starting fresh.`);
  } else {
    const existing = await loadState();
    if (existing && existing.completedSteps.length > 0) {
      const checklist = ALL_STEPS.map((st) => {
        const done = existing.completedSteps.includes(st.id);
        return done
          ? `${color.green('✔')} ${color.dim(st.label)}`
          : `${color.yellow('○')} ${st.label}`;
      }).join('\n');

      p.note(checklist, 'Saved setup progress detected');

      const resumeMode = unwrapPrompt(
        await p.select({
          message: 'How would you like to proceed?',
          options: [
            {
              value: 'resume',
              label: 'Resume from last successful step',
              hint: 'skips completed steps',
            },
            {
              value: 'reset',
              label: 'Start fresh',
              hint: 're-enter config and re-run all steps',
            },
          ],
        })
      );

      if (resumeMode === 'reset') {
        await clearState();
        p.log.info('Cleared saved progress. Starting fresh.');
      } else {
        state = existing;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 1: Cloudflare Wrangler Authentication
  // ---------------------------------------------------------------------------
  if (isStepDone(state, 'auth')) {
    p.log.success(`${color.dim('[1/6]')} Cloudflare authentication ${color.dim('(already completed)')}`);
  } else {
    const authSpinner = p.spinner();
    authSpinner.start('Checking Cloudflare Wrangler authentication...');
    let whoami = await runCommand(['bunx', 'wrangler', 'whoami']);

    if (whoami.exitCode !== 0 || /not authenticated|login/i.test(whoami.stdout + whoami.stderr)) {
      authSpinner.stop(color.yellow('Not logged in to Cloudflare'));

      const shouldLogin = unwrapPrompt(
        await p.confirm({
          message: 'Authenticate with Cloudflare via `wrangler login` now?',
          active: 'Yes, open browser',
          inactive: 'No, exit',
          initialValue: true,
        })
      );

      if (!shouldLogin) {
        p.cancel('Run `bunx wrangler login` and re-run `bun run setup`.');
        process.exit(0);
      }

      p.log.step('Launching Cloudflare OAuth login in your browser...');
      const loginRes = await runCommand(['bunx', 'wrangler', 'login'], { inheritStdio: true });
      if (loginRes.exitCode !== 0) {
        throw new Error('Wrangler login failed. Please authenticate and try again.');
      }

      authSpinner.start('Verifying Cloudflare session...');
      whoami = await runCommand(['bunx', 'wrangler', 'whoami']);
      if (whoami.exitCode !== 0) {
        authSpinner.error('Could not verify Cloudflare authentication');
        throw new Error('Unable to verify Wrangler authentication after login.');
      }
    }

    const account = parseCloudflareAccount(whoami.stdout);
    authSpinner.stop(
      account
        ? `Authenticated with Cloudflare ${color.dim(`(${account})`)}`
        : 'Authenticated with Cloudflare'
    );
    await markStepDone(state, 'auth');
  }

  // ---------------------------------------------------------------------------
  // Step 2: Telegram Bot Token & Owner Lock
  // ---------------------------------------------------------------------------
  if (isStepDone(state, 'config') && state.botToken) {
    p.log.success(`${color.dim('[2/6]')} Telegram bot & owner config ${color.dim('(already completed)')}`);
  } else {
    p.note(
      [
        `1. Open Telegram and message ${color.cyan('@BotFather')}`,
        `2. Send ${color.bold('/newbot')} and pick a display name & username`,
        `3. Copy the ${color.bold('HTTP API Token')} it gives you`,
      ].join('\n'),
      'Telegram BotFather Guide'
    );

    const botToken = unwrapPrompt(
      await p.password({
        message: 'Paste your @BotFather HTTP API Token',
        mask: '•',
        clearOnError: true,
        validate: (val) => {
          const trimmed = (val ?? '').trim();
          if (!trimmed) return 'Bot token is required.';
          if (!BOT_TOKEN_REGEX.test(trimmed)) {
            return 'Invalid format — expected something like 123456789:ABCdef...';
          }
        },
      })
    );

    const ownerMode = unwrapPrompt(
      await p.select({
        message: 'How should ownership of your private bot be locked?',
        options: [
          {
            value: 'auto',
            label: 'Auto-claim on first /start',
            hint: 'recommended — just tap Start in Telegram',
          },
          {
            value: 'explicit',
            label: 'Pre-lock to a specific Telegram User ID',
            hint: 'requires numeric ID from @userinfobot',
          },
        ],
      })
    );

    let ownerTelegramId = '';
    if (ownerMode === 'explicit') {
      const idInput = unwrapPrompt(
        await p.text({
          message: 'Enter your numeric Telegram User ID',
          placeholder: '123456789',
          validate: (val) => {
            const trimmed = (val ?? '').trim();
            if (!/^\d+$/.test(trimmed)) return 'Please enter digits only (e.g. 123456789).';
          },
        })
      );
      ownerTelegramId = idInput.trim();
    }

    state.botToken = botToken.trim();
    state.ownerTelegramId = ownerTelegramId;
    await markStepDone(state, 'config');
  }

  // ---------------------------------------------------------------------------
  // Step 3: Cloudflare Worker Name, D1 Database & Remote Migrations
  // ---------------------------------------------------------------------------
  if (isStepDone(state, 'd1') && state.workerName && state.dbName && state.databaseId) {
    p.log.success(
      `${color.dim('[3/6]')} D1 database ${color.cyan(state.dbName)} & migrations ${color.dim('(already completed)')}`
    );
  } else {
    const infra = await p.group(
      {
        workerName: () =>
          p.text({
            message: 'Cloudflare Worker name',
            placeholder: 'smpg-core',
            defaultValue: state.workerName || 'smpg-core',
            validate: (val) => {
              const v = (val ?? '').trim();
              if (v && !WORKER_NAME_REGEX.test(v)) {
                return 'Use lowercase letters, numbers, and hyphens only (e.g. smpg-core).';
              }
            },
          }),
        dbName: () =>
          p.text({
            message: 'Cloudflare D1 database name',
            placeholder: 'smpg',
            defaultValue: state.dbName || 'smpg',
            validate: (val) => {
              const v = (val ?? '').trim();
              if (v && !WORKER_NAME_REGEX.test(v)) {
                return 'Use lowercase letters, numbers, and hyphens only (e.g. smpg).';
              }
            },
          }),
      },
      {
        onCancel: () => {
          p.cancel('Setup paused. Run `bun run setup` anytime to resume.');
          process.exit(0);
        },
      }
    );

    const workerName = infra.workerName.trim();
    const dbName = infra.dbName.trim();

    const dbSpinner = p.spinner({ indicator: 'timer' });
    dbSpinner.start(`Provisioning D1 database ${color.cyan(dbName)}...`);

    const createDbRes = await runCommand(['bunx', 'wrangler', 'd1', 'create', dbName]);
    let detectedDbId = parseDatabaseId(`${createDbRes.stdout}\n${createDbRes.stderr}`);

    if (!detectedDbId) {
      const combined = `${createDbRes.stdout}\n${createDbRes.stderr}`;
      if (/already exists/i.test(combined)) {
        dbSpinner.message(`D1 database ${color.cyan(dbName)} exists — looking up database_id...`);
        detectedDbId = await findExistingD1DatabaseId(dbName);
      }
    }

    let databaseId: string;
    if (!detectedDbId) {
      dbSpinner.stop(color.yellow('Could not auto-detect D1 database_id'));
      const manualId = unwrapPrompt(
        await p.text({
          message: 'Paste your D1 database_id (UUID)',
          placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
          validate: (val) => {
            if (!/^[0-9a-fA-F-]{36}$/.test((val ?? '').trim())) {
              return 'Must be a valid 36-character UUID.';
            }
          },
        })
      );
      databaseId = manualId.trim();
      dbSpinner.start('Writing configuration & applying migrations...');
    } else {
      databaseId = detectedDbId;
    }

    dbSpinner.message('Writing apps/core/wrangler.toml...');
    const wranglerToml = buildWranglerToml(workerName, dbName, databaseId);
    await writeFile(WRANGLER_TOML_PATH, wranglerToml, 'utf-8');

    dbSpinner.message(`Applying D1 migrations remotely to ${color.cyan(dbName)}...`);
    const migrateRes = await runCommand(
      ['bunx', 'wrangler', 'd1', 'migrations', 'apply', dbName, '--remote'],
      { stdinText: 'y\n' }
    );
    if (migrateRes.exitCode !== 0) {
      dbSpinner.error('Failed to apply D1 migrations');
      throw new Error((migrateRes.stderr || migrateRes.stdout).trim() || 'D1 migration failed');
    }

    dbSpinner.stop(
      `D1 database ${color.cyan(dbName)} provisioned & migrated ${color.dim(`(${databaseId.slice(0, 8)}...)`)}`
    );

    state.workerName = workerName;
    state.dbName = dbName;
    state.databaseId = databaseId;
    await markStepDone(state, 'd1');
  }

  // ---------------------------------------------------------------------------
  // Step 4: Deploy Worker to Cloudflare
  // ---------------------------------------------------------------------------
  if (isStepDone(state, 'deploy') && state.workerUrl) {
    p.log.success(
      `${color.dim('[4/6]')} Worker deployed at ${color.cyan(state.workerUrl)} ${color.dim('(already completed)')}`
    );
  } else {
    const deploySpinner = p.spinner({ indicator: 'timer' });
    deploySpinner.start(`Deploying ${color.cyan(state.workerName!)} to Cloudflare Workers...`);

    const deployRes = await runCommand(['bunx', 'wrangler', 'deploy']);
    if (deployRes.exitCode !== 0) {
      deploySpinner.error('Wrangler deploy failed');
      throw new Error((deployRes.stderr || deployRes.stdout).trim() || 'Wrangler deploy failed');
    }

    const detectedWorkerUrl = parseWorkerUrl(`${deployRes.stdout}\n${deployRes.stderr}`);
    let workerUrl: string;
    if (!detectedWorkerUrl) {
      deploySpinner.stop(color.yellow('Worker deployed — URL not auto-detected'));
      const urlInput = unwrapPrompt(
        await p.text({
          message: 'Enter your deployed Worker URL',
          placeholder: `https://${state.workerName}.<subdomain>.workers.dev`,
          validate: (val) => {
            const v = (val ?? '').trim();
            if (!v.startsWith('https://')) return 'URL must start with https://';
          },
        })
      );
      workerUrl = urlInput.trim().replace(/\/+$/, '');
    } else {
      workerUrl = detectedWorkerUrl;
      deploySpinner.stop(`Worker deployed at ${color.cyan(color.underline(workerUrl))}`);
    }

    state.workerUrl = workerUrl;
    await markStepDone(state, 'deploy');
  }

  // ---------------------------------------------------------------------------
  // Step 5: Generate & Upload Cryptographic Secrets
  // ---------------------------------------------------------------------------
  if (isStepDone(state, 'secrets') && state.webhookSecret && state.encryptionKey) {
    p.log.success(`${color.dim('[5/6]')} Worker secrets uploaded ${color.dim('(already completed)')}`);
  } else {
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

    const bar = p.progress({ style: 'block', max: secrets.length, size: 28 });
    bar.start(`Uploading ${secrets.length} encrypted secrets to Cloudflare...`);

    for (let i = 0; i < secrets.length; i++) {
      const [key, value] = secrets[i];
      bar.message(`Uploading ${color.cyan(key)} ${color.dim(`(${i + 1}/${secrets.length})`)}`);
      try {
        await putSecret(key, value);
      } catch (err) {
        bar.error(`Failed while uploading ${key}`);
        throw err;
      }
      bar.advance(1);
    }

    bar.stop(`Uploaded ${color.green(String(secrets.length))} encrypted Worker secrets`);

    state.encryptionKey = encryptionKey;
    state.webhookSecret = webhookSecret;
    await markStepDone(state, 'secrets');
  }

  // ---------------------------------------------------------------------------
  // Step 6: Register Telegram Webhook via Cloudflare Edge
  // ---------------------------------------------------------------------------
  if (isStepDone(state, 'webhook')) {
    p.log.success(`${color.dim('[6/6]')} Telegram webhook registered ${color.dim('(already completed)')}`);
  } else {
    const hookSpinner = p.spinner({ indicator: 'timer' });
    hookSpinner.start('Registering Telegram webhook from Cloudflare edge...');

    try {
      const { webhookUrl, bot } = await registerWebhookViaWorker(
        state.workerUrl!,
        state.webhookSecret!,
        hookSpinner
      );

      if (bot) {
        state.botUsername = bot.username;
        hookSpinner.message(`Verified ${color.cyan(`@${bot.username}`)} — caching BOT_INFO...`);
        await putSecret('BOT_INFO', JSON.stringify(bot));
        hookSpinner.stop(
          `Webhook live for ${color.cyan(`@${bot.username}`)} ${color.dim(`→ ${webhookUrl}`)}`
        );
      } else {
        hookSpinner.stop(`Webhook registered ${color.dim(`→ ${webhookUrl}`)}`);
      }

      await markStepDone(state, 'webhook');
    } catch (err) {
      hookSpinner.error('Telegram webhook registration failed');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Finish & Cleanup
  // ---------------------------------------------------------------------------
  const finalWorkerUrl = state.workerUrl!;
  const finalBotUsername = state.botUsername;
  const finalDbName = state.dbName || 'smpg';
  const ownerSummary = state.ownerTelegramId
    ? `Locked to ID ${color.cyan(state.ownerTelegramId)}`
    : `${color.green('Auto-claim')} on first ${color.bold('/start')}`;

  await clearState();

  const summaryLines = [
    `${color.dim('Worker URL   ')} ${color.cyan(color.underline(finalWorkerUrl))}`,
    `${color.dim('Telegram Bot ')} ${finalBotUsername ? color.cyan(color.underline(`https://t.me/${finalBotUsername}`)) : color.white('Open your bot in Telegram')}`,
    `${color.dim('D1 Database  ')} ${color.white(finalDbName)}`,
    `${color.dim('Owner Lock   ')} ${ownerSummary}`,
  ].join('\n');

  p.box(summaryLines, color.bold(color.green(' SMPG Core Deployed ')), {
    rounded: true,
    formatBorder: color.cyan,
    contentPadding: 2,
  });

  const nextSteps = [
    `${color.cyan('1.')} Open your Telegram bot and tap ${color.bold('Start')} to claim ownership & create your first store.`,
    `${color.cyan('2.')} Run ${color.bold('/wallets')} to add your personal bKash / Nagad SIM numbers.`,
    `${color.cyan('3.')} Add ${color.bold('SMPG_CORE_URL')}, ${color.bold('SMPG_SECRET_KEY')}, and ${color.bold('SMPG_WEBHOOK_SECRET')} to your storefront.`,
  ].join('\n');

  p.note(nextSteps, 'Next steps');

  p.outro(
    `${color.green('All set!')} Need integration recipes? See ${color.underline(color.cyan('https://github.com/siam19/smpg#readme'))}`
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(color.red(message));

  if (/Too Many Requests|429|retry after/i.test(message)) {
    p.note(
      [
        'Telegram is temporarily rate-limiting this bot token.',
        `• Make sure no other script or server is polling the same token.`,
        `• Wait out Telegram's cooldown, or create a fresh bot via ${color.cyan('@BotFather')}.`,
        `• Re-run ${color.bold('bun run setup')} to resume right at webhook registration,`,
        `  or ${color.bold('bun run setup -- --reset')} to switch bot tokens.`,
      ].join('\n'),
      'Troubleshooting'
    );
  } else {
    p.log.info(
      `Progress was saved. Fix the issue and run ${color.bold('bun run setup')} to resume.`
    );
  }

  p.outro(color.dim('Setup exited with errors.'));
  process.exit(1);
});
