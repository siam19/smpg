import { InlineKeyboard } from 'grammy';
import type { Payment, Store, Wallet } from '../../db/schema';
import { randomBytesHex } from '../../services/crypto';

/**
 * Creates inline buttons for new bKash / Nagad submissions.
 */
export function createPaymentActionKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard()
    .text('Approve', `v1:approve:${paymentId}:${nonce}`)
    .text('Reject', `v1:reject:${paymentId}:${nonce}`);
}

/**
 * Creates inline buttons for new COD orders.
 */
export function createCodActionKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard()
    .text('Confirm', `v1:confirm:${paymentId}:${nonce}`)
    .text('Cancel', `v1:cancel:${paymentId}:${nonce}`);
}

/**
 * Creates inline button for the 90-second Undo grace period.
 */
export function createUndoKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard().text('Undo', `v1:undo:${paymentId}:${nonce}`);
}

/**
 * Main dashboard menu keyboard.
 */
export function createMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Stores', 'menu:stores')
    .text('Wallets', 'menu:wallets')
    .row()
    .text('Payments', 'menu:payments')
    .text('Help', 'menu:help');
}

/**
 * Stores management dashboard keyboard.
 */
export function createStoresDashboardKeyboard(storeList: Store[]): InlineKeyboard {
  const kb = new InlineKeyboard().text('+ Create Store', 'store:create').row();

  for (const s of storeList) {
    const statusTag = s.paused === 1 ? '[Paused]' : '[Active]';
    kb.text(`${statusTag} ${s.name}`, `store:view:${s.id}`).row();
  }

  kb.text('<< Main Menu', 'menu:main');
  return kb;
}

/**
 * Store detail view keyboard.
 */
export function createStoreDetailKeyboard(store: Store): InlineKeyboard {
  const codText = store.codEnabled === 1 ? 'COD: Enabled (Turn OFF)' : 'COD: Disabled (Turn ON)';
  const pauseText = store.paused === 1 ? 'Resume Store' : 'Pause Store';

  return new InlineKeyboard()
    .text('View Server Credentials', `store:creds:${store.id}`)
    .row()
    .text('Rename', `store:rename:${store.id}`)
    .text('API Keys', `store:keys:${store.id}`)
    .row()
    .text('Set Webhook', `store:webhook:${store.id}`)
    .text('Test Ping', `store:ping:${store.id}`)
    .row()
    .text(codText, `store:toggle_cod:${store.id}`)
    .row()
    .text(pauseText, `store:toggle_pause:${store.id}`)
    .text('Delete Store', `store:delete_confirm:${store.id}`)
    .row()
    .text('<< Back to Stores', 'menu:stores');
}

/**
 * Store deletion confirmation keyboard.
 */
export function createStoreDeleteConfirmKeyboard(storeId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirm Delete', `store:delete:${storeId}`)
    .text('Cancel', `store:view:${storeId}`);
}

/**
 * Store API keys & webhook secret keyboard.
 */
export function createStoreKeysKeyboard(storeId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('View Server Credentials', `store:creds:${storeId}`)
    .row()
    .text('Rotate Live Key', `keys:rotate:live:${storeId}`)
    .text('Rotate Test Key', `keys:rotate:test:${storeId}`)
    .row()
    .text('Show Webhook Secret', `keys:whsec:${storeId}`)
    .row()
    .text('<< Back to Store', `store:view:${storeId}`);
}

/**
 * Interactive Wallets Dashboard keyboard.
 */
export function createWalletsDashboardKeyboard(
  walletList: Wallet[],
  rotationStrategy: string
): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('+ Add bKash', 'wallet:add:bkash')
    .text('+ Add Nagad', 'wallet:add:nagad')
    .row()
    .text(
      `Mode: ${rotationStrategy === 'fill_first' ? 'Fill First' : 'Balanced'} (Toggle)`,
      'wallet:toggle_strategy'
    )
    .row();

  for (const w of walletList) {
    const providerTag = w.provider === 'bkash' ? 'bKash' : 'Nagad';
    const statusTag = w.active === 1 ? '[Active]' : '[Paused]';
    const labelTag = w.label ? ` (${w.label})` : '';
    kb.text(`${statusTag} ${providerTag}: ${w.number}${labelTag}`, `wallet:view:${w.id}`).row();
  }

  kb.text('<< Main Menu', 'menu:main');
  return kb;
}

/**
 * Specific wallet detail view keyboard.
 */
export function createWalletDetailKeyboard(wallet: Wallet): InlineKeyboard {
  const toggleAction = wallet.active === 1 ? 'Pause' : 'Resume';
  return new InlineKeyboard()
    .text('Edit Limit', `wallet:edit_limit:${wallet.id}`)
    .text(toggleAction, `wallet:toggle_active:${wallet.id}`)
    .row()
    .text('Assign Store / Make Shared', `wallet:scope:${wallet.id}`)
    .row()
    .text('Delete Wallet', `wallet:delete:${wallet.id}`)
    .row()
    .text('<< Back to Wallets', 'menu:wallets');
}

/**
 * Wallet store-scope selection keyboard.
 */
export function createWalletScopeKeyboard(
  walletId: string,
  storeList: Store[],
  currentStoreId: string | null
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const sharedPrefix = currentStoreId === null ? '[Current] ' : '';
  kb.text(`${sharedPrefix}All Stores (Shared)`, `wallet:set_scope:${walletId}:shared`).row();

  for (const s of storeList) {
    const prefix = currentStoreId === s.id ? '[Current] ' : '';
    kb.text(`${prefix}${s.name}`, `wallet:set_scope:${walletId}:${s.id}`).row();
  }

  kb.text('<< Back to Wallet', `wallet:view:${walletId}`);
  return kb;
}

/**
 * Payments dashboard keyboard.
 */
export function createPaymentsKeyboard(reopenablePayments: Payment[] = []): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const p of reopenablePayments.slice(0, 3)) {
    kb.text(`Reopen ${p.id} (৳${p.amount})`, `pay:reopen:${p.id}`).row();
  }

  kb.text('Refresh', 'menu:payments').text('<< Main Menu', 'menu:main');
  return kb;
}
