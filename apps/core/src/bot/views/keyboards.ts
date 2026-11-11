import { InlineKeyboard } from 'grammy';
import type { Merchant, MerchantWallet, Payment } from '../../db/schema';
import { randomBytesHex } from '../../services/crypto';

/**
 * Creates inline buttons for new bKash / Nagad submissions.
 */
export function createPaymentActionKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard()
    .text('✅ Approve', `v1:approve:${paymentId}:${nonce}`)
    .text('❌ Reject', `v1:reject:${paymentId}:${nonce}`);
}

/**
 * Creates inline buttons for new COD orders.
 */
export function createCodActionKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard()
    .text('✅ Confirm', `v1:confirm:${paymentId}:${nonce}`)
    .text('❌ Cancel', `v1:cancel:${paymentId}:${nonce}`);
}

/**
 * Creates inline button for the 90-second Undo grace period.
 */
export function createUndoKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard().text('↩ Undo', `v1:undo:${paymentId}:${nonce}`);
}

/**
 * Onboarding: NID / Passport availability keyboard.
 */
export function createNidQuestionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Yes', 'onboarding:nid:yes')
    .text('No', 'onboarding:nid:no');
}

/**
 * Onboarding: Create Store action keyboard (single button).
 */
export function createCreateStoreKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🏪 Create Store', 'onboarding:create_store');
}

/**
 * Onboarding: Brand color selection with Skip button.
 */
export function createBrandColorKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('⏭ Skip', 'onboarding:skip_color');
}

/**
 * Main dashboard menu keyboard.
 */
export function createMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📱 Wallets', 'menu:wallets')
    .text('💳 Payments', 'menu:payments')
    .row()
    .text('⚙️ Settings', 'menu:settings')
    .text('🔑 API Keys', 'menu:keys')
    .row()
    .text('📖 Help', 'menu:help');
}

/**
 * Interactive Wallets Dashboard keyboard.
 */
export function createWalletsDashboardKeyboard(
  wallets: MerchantWallet[],
  rotationStrategy: string
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('➕ Add bKash', 'wallet:add:bkash')
    .text('➕ Add Nagad', 'wallet:add:nagad')
    .row()
    .text(`🔄 Mode: ${rotationStrategy === 'fill_first' ? 'Fill First' : 'Balanced'} (Toggle)`, 'wallet:toggle_strategy')
    .row();

  // Button for each wallet
  for (const w of wallets) {
    const providerTag = w.provider === 'bkash' ? 'bKash' : 'Nagad';
    const statusTag = w.active === 1 ? '🟢' : '⏸';
    const labelTag = w.label ? ` (${w.label})` : '';
    kb.text(`${statusTag} ${providerTag}: ${w.number}${labelTag}`, `wallet:view:${w.id}`).row();
  }

  kb.text('« Main Menu', 'menu:main');
  return kb;
}

/**
 * Specific wallet detail view keyboard.
 */
export function createWalletDetailKeyboard(wallet: MerchantWallet): InlineKeyboard {
  const toggleAction = wallet.active === 1 ? '⏸ Pause' : '▶️ Resume';
  return new InlineKeyboard()
    .text('✏️ Edit Limit', `wallet:edit_limit:${wallet.id}`)
    .text(toggleAction, `wallet:toggle_active:${wallet.id}`)
    .row()
    .text('🗑 Delete Wallet', `wallet:delete:${wallet.id}`)
    .row()
    .text('« Back to Wallets', 'menu:wallets');
}

/**
 * Settings dashboard keyboard.
 */
export function createSettingsKeyboard(merchant: Merchant): InlineKeyboard {
  const codText = merchant.codEnabled === 1 ? '📦 COD: Active (Turn OFF)' : '📦 COD: Inactive (Turn ON)';
  const pauseText = merchant.paused === 1 ? '▶️ Resume Store' : '⏸ Pause Store';

  return new InlineKeyboard()
    .text('✏️ Store Name', 'settings:store_name')
    .text('🎨 Brand Color', 'settings:brand_color')
    .row()
    .text(codText, 'settings:toggle_cod')
    .row()
    .text('🔗 Set Webhook', 'settings:webhook')
    .text('📡 Test Ping', 'settings:ping_webhook')
    .row()
    .text(pauseText, 'settings:toggle_pause')
    .row()
    .text('« Main Menu', 'menu:main');
}

/**
 * API Keys dashboard keyboard.
 */
export function createKeysKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Rotate Live Key', 'keys:rotate:live')
    .text('🔄 Rotate Test Key', 'keys:rotate:test')
    .row()
    .text('« Main Menu', 'menu:main');
}

/**
 * Payments dashboard keyboard.
 */
export function createPaymentsKeyboard(reopenablePayments: Payment[] = []): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Add 1-tap reopen buttons for recent rejected payments
  for (const p of reopenablePayments.slice(0, 3)) {
    kb.text(`🔄 Reopen ${p.id} (৳${p.amount})`, `pay:reopen:${p.id}`).row();
  }

  kb.text('🔄 Refresh', 'menu:payments').text('« Main Menu', 'menu:main');
  return kb;
}
