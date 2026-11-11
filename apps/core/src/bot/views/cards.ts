import type { Payment, MerchantWallet } from '../../db/schema';

/**
 * Formats a bKash or Nagad payment submission card.
 */
export function formatSubmittedCard(payment: Payment, wallet?: MerchantWallet | null): string {
  const isBkash = payment.method === 'bkash';
  const methodLabel = isBkash ? 'bKash' : 'Nagad';
  const trxLabel = isBkash ? 'TrxID' : 'TxnID';
  const lateBadge = payment.lateSubmission ? ' ⏰ submitted late' : '';
  const orderRef = payment.externalOrderId ? ` · ${payment.externalOrderId}` : '';

  const walletDisplay = wallet
    ? `${wallet.number}${wallet.label ? ` (${wallet.label})` : ''}`
    : payment.walletId || 'Assigned Wallet';

  return [
    `💸 <b>${methodLabel} payment${orderRef}${lateBadge}</b>`,
    `<b>Amount:</b> ৳${payment.amount.toLocaleString('en-BD')}`,
    `<b>Sent to:</b> <code>${walletDisplay}</code>`,
    `<b>${trxLabel}:</b> <code>${payment.trxId || 'N/A'}</code>`,
    `<b>From:</b> <code>${payment.senderNumber || 'N/A'}</code>`,
    '',
    `<i>Check this ${trxLabel}, amount and sender in your ${methodLabel} app before approving.</i>`,
  ].join('\n');
}

/**
 * Formats a Cash on Delivery (COD) notification card.
 */
export function formatCodCard(payment: Payment): string {
  const orderRef = payment.externalOrderId ? ` · ${payment.externalOrderId}` : '';
  const customerName = payment.customerName || 'Customer';
  const customerPhone = payment.customerPhone ? ` ${payment.customerPhone}` : '';

  return [
    `📦 <b>COD order${orderRef}</b>`,
    `<b>Amount:</b> ৳${payment.amount.toLocaleString('en-BD')}`,
    `<b>Customer:</b> ${customerName}${customerPhone}`,
    '',
    '<i>Confirm or cancel this COD order before fulfilling.</i>',
  ].join('\n');
}

/**
 * Formats the card during the 90-second Undo grace period.
 */
export function appendGracePeriodStatus(
  originalCard: string,
  action: 'approve' | 'reject' | 'confirm' | 'cancel',
  actor: string,
  deadlineIsoOrTime: string
): string {
  let label = '';
  switch (action) {
    case 'approve':
      label = '⏳ Approving';
      break;
    case 'reject':
      label = '❌ Rejecting';
      break;
    case 'confirm':
      label = '📦 Confirming';
      break;
    case 'cancel':
      label = '🚫 Cancelling';
      break;
  }

  return `${originalCard}\n\n<b>${label} by ${actor}</b> · final at <code>${deadlineIsoOrTime}</code>`;
}

/**
 * Formats the final static badge when decision is finalized.
 */
export function appendFinalDecisionStatus(
  originalCard: string,
  action: string,
  actor: string,
  timeString: string
): string {
  let badge = '';
  if (action === 'approve' || action === 'PAID') {
    badge = '✅ Approved';
  } else if (action === 'reject' || action === 'REJECTED') {
    badge = '❌ Rejected';
  } else if (action === 'confirm' || action === 'CONFIRMED') {
    badge = '📦 Confirmed';
  } else if (action === 'cancel' || action === 'CANCELLED') {
    badge = '🚫 Cancelled';
  } else {
    badge = `Decision: ${action}`;
  }

  return `${originalCard}\n\n<b>${badge} by ${actor} · ${timeString}</b>`;
}
