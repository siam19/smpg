'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SMPGCheckout,
  SMPGError,
  type AssignedWallet,
  type CheckoutSessionData,
  type PaymentMethod,
  type PaymentStatus,
  type SubmitPaymentResult,
} from 'send-money-payment-gateway';

export interface SMPGCheckoutBoxProps {
  /** Payment ID returned by your backend's `smpg.payments.create(...)` call */
  paymentId: string;
  /** Your self-hosted SMPG Core Worker URL (e.g. https://smpg-core.<subdomain>.workers.dev) */
  baseUrl: string;
  /** Optional callback fired after TrxID submission or COD confirmation */
  onSuccess?: (result: SubmitPaymentResult | { method: 'cod'; status: PaymentStatus }) => void;
  /** Optional callback fired when the user clicks Cancel */
  onCancel?: () => void;
}

const METHOD_LABELS: Record<PaymentMethod, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  cod: 'Cash on Delivery',
};

export function SMPGCheckoutBox({
  paymentId,
  baseUrl,
  onSuccess,
  onCancel,
}: SMPGCheckoutBoxProps) {
  const checkout = useMemo(() => new SMPGCheckout({ baseUrl }), [baseUrl]);

  const [session, setSession] = useState<CheckoutSessionData | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | null>(null);
  const [wallet, setWallet] = useState<AssignedWallet | null>(null);
  const [status, setStatus] = useState<PaymentStatus>('CREATED');
  const [attemptsRemaining, setAttemptsRemaining] = useState<number>(3);

  const [trxId, setTrxId] = useState('');
  const [senderNumber, setSenderNumber] = useState('');
  const [copied, setCopied] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1. Load checkout session on mount
  const loadSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await checkout.getSession(paymentId);
      setSession(data);
      setSelectedMethod(data.method);
      setWallet(data.assigned_wallet);
      setStatus(data.status);
      setAttemptsRemaining(data.attempts_remaining);
    } catch (err) {
      setError(err instanceof SMPGError ? err.message : 'Failed to load payment session.');
    } finally {
      setLoading(false);
    }
  }, [checkout, paymentId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // 2. Poll payment status while awaiting owner verification in Telegram
  useEffect(() => {
    if (status !== 'SUBMITTED') return;

    const timer = setInterval(async () => {
      try {
        const res = await checkout.getStatus(paymentId);
        if (res.status !== status) {
          setStatus(res.status);
          if (res.status === 'REJECTED') {
            // Refresh full session so attempts_remaining and wallet info are up to date
            await loadSession();
          }
        }
      } catch {
        // Ignore transient polling errors
      }
    }, 5000);

    return () => clearInterval(timer);
  }, [checkout, loadSession, paymentId, status]);

  // 3. Select payment method (bKash / Nagad / COD)
  const handleSelectMethod = async (method: PaymentMethod) => {
    setBusy(true);
    setError(null);
    try {
      const res = await checkout.selectMethod(paymentId, method);
      setSelectedMethod(res.method);
      setStatus(res.status);
      setWallet(res.assigned_wallet ?? null);

      if (method === 'cod' && res.status === 'CONFIRMED') {
        onSuccess?.({ method: 'cod', status: res.status });
      }
    } catch (err) {
      setError(err instanceof SMPGError ? err.message : 'Could not select payment method.');
    } finally {
      setBusy(false);
    }
  };

  // 4. One-click copy for assigned wallet number
  const handleCopyWallet = async () => {
    if (!wallet?.number) return;
    try {
      await navigator.clipboard.writeText(wallet.number);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Unable to copy wallet number. Please copy it manually.');
    }
  };

  // 5. Submit TrxID (initial submission or retry after rejection)
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedTrx = trxId.trim();
    if (!cleanedTrx) return;

    setBusy(true);
    setError(null);
    try {
      const result = await checkout.submit(paymentId, {
        trx_id: cleanedTrx,
        ...(senderNumber.trim() ? { sender_number: senderNumber.trim() } : {}),
      });
      setStatus(result.status);
      setAttemptsRemaining(result.attempts_remaining);
      setTrxId('');
      onSuccess?.(result);
    } catch (err) {
      setError(err instanceof SMPGError ? err.message : 'Failed to submit Transaction ID.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={styles.card}>
        <p style={styles.muted}>Loading checkout...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={styles.card}>
        <div style={styles.errorBox}>{error || 'Payment session not found.'}</div>
      </div>
    );
  }

  const canSubmit =
    (status === 'CREATED' || (status === 'REJECTED' && attemptsRemaining > 0)) &&
    (selectedMethod === 'bkash' || selectedMethod === 'nagad') &&
    Boolean(wallet);

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>{session.store.name}</h2>
          {session.external_order_id && (
            <p style={styles.muted}>Order {session.external_order_id}</p>
          )}
        </div>
        <div style={styles.amount}>&#2547;{session.amount}</div>
      </div>

      {error && <div style={styles.errorBox}>{error}</div>}

      {/* Final / Pending States */}
      {status === 'PAID' && (
        <div style={styles.successBox}>
          <strong>Payment verified!</strong> Thank you for your order.
        </div>
      )}

      {status === 'CONFIRMED' && (
        <div style={styles.successBox}>
          <strong>Cash on Delivery confirmed!</strong> Pay &#2547;{session.amount} upon delivery.
        </div>
      )}

      {status === 'SUBMITTED' && (
        <div style={styles.infoBox}>
          <strong>Payment submitted!</strong> The store owner is verifying your transaction. This
          page updates automatically.
        </div>
      )}

      {(status === 'EXPIRED' || status === 'CANCELLED') && (
        <div style={styles.errorBox}>
          This payment session is <strong>{status.toLowerCase()}</strong>. Please start a new
          checkout from your cart.
        </div>
      )}

      {status === 'REJECTED' && (
        <div style={styles.errorBox}>
          <strong>Transaction ID rejected.</strong>{' '}
          {attemptsRemaining > 0
            ? `Please double-check your receipt and retry (${attemptsRemaining} ${
                attemptsRemaining === 1 ? 'attempt' : 'attempts'
              } remaining).`
            : 'No retry attempts remaining. Please contact the store.'}
        </div>
      )}

      {/* Method Selector (available while CREATED) */}
      {status === 'CREATED' && (
        <div style={styles.section}>
          <p style={styles.label}>Select Payment Method</p>
          <div style={styles.methodGrid}>
            {session.available_methods.map((method) => {
              const active = selectedMethod === method;
              return (
                <button
                  key={method}
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSelectMethod(method)}
                  style={{
                    ...styles.methodButton,
                    ...(active ? styles.methodButtonActive : {}),
                  }}
                >
                  {METHOD_LABELS[method]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Assigned Wallet + TrxID Form (CREATED or REJECTED with attempts left) */}
      {canSubmit && wallet && (
        <div style={styles.section}>
          <div style={styles.walletBox}>
            <div style={styles.walletHint}>
              Send <strong>&#2547;{session.amount}</strong> via{' '}
              <strong>{METHOD_LABELS[wallet.provider]} Send Money</strong> to:
            </div>
            <div style={styles.walletRow}>
              <span style={styles.walletNumber}>{wallet.number}</span>
              <button type="button" onClick={() => void handleCopyWallet()} style={styles.copyBtn}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            {wallet.label && <div style={styles.walletLabel}>{wallet.label}</div>}
          </div>

          <form onSubmit={handleSubmit}>
            <div style={styles.field}>
              <label htmlFor="smpg-trx-id" style={styles.label}>
                {status === 'REJECTED' ? 'Corrected Transaction ID (TrxID)' : 'Transaction ID (TrxID)'}
              </label>
              <input
                id="smpg-trx-id"
                type="text"
                required
                value={trxId}
                onChange={(e) => setTrxId(e.target.value)}
                placeholder="e.g. 9A8B7C6D5E"
                autoComplete="off"
                style={styles.input}
              />
            </div>

            <div style={styles.field}>
              <label htmlFor="smpg-sender-phone" style={styles.label}>
                Sender Number (Optional)
              </label>
              <input
                id="smpg-sender-phone"
                type="tel"
                value={senderNumber}
                onChange={(e) => setSenderNumber(e.target.value)}
                placeholder="01XXXXXXXXX"
                style={styles.input}
              />
            </div>

            <button type="submit" disabled={busy || !trxId.trim()} style={styles.submitBtn}>
              {busy
                ? 'Submitting...'
                : status === 'REJECTED'
                  ? 'Resubmit Transaction ID'
                  : 'Submit Transaction ID'}
            </button>
          </form>
        </div>
      )}

      {onCancel && status === 'CREATED' && (
        <button type="button" onClick={onCancel} style={styles.cancelBtn}>
          Cancel
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    maxWidth: 440,
    margin: '0 auto',
    padding: 24,
    borderRadius: 12,
    border: '1px solid #e5e7eb',
    backgroundColor: '#ffffff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#111827',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottom: '1px solid #f3f4f6',
  },
  title: { margin: 0, fontSize: 18, fontWeight: 700 },
  muted: { margin: '4px 0 0', fontSize: 13, color: '#6b7280' },
  amount: { fontSize: 22, fontWeight: 700 },
  section: { marginTop: 16 },
  label: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 },
  methodGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  methodButton: {
    padding: '10px 8px',
    borderRadius: 8,
    border: '1px solid #d1d5db',
    backgroundColor: '#ffffff',
    color: '#111827',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
  },
  methodButtonActive: {
    borderColor: '#111827',
    backgroundColor: '#111827',
    color: '#ffffff',
  },
  walletBox: {
    backgroundColor: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: 8,
    padding: '12px 14px',
    marginBottom: 16,
  },
  walletHint: { fontSize: 13, color: '#166534' },
  walletRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  walletNumber: { fontFamily: 'monospace', fontSize: 18, fontWeight: 700 },
  walletLabel: { fontSize: 12, color: '#15803d', marginTop: 4 },
  copyBtn: {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #86efac',
    backgroundColor: '#ffffff',
    color: '#166534',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  },
  field: { marginBottom: 12 },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid #d1d5db',
    fontSize: 14,
    boxSizing: 'border-box',
  },
  submitBtn: {
    width: '100%',
    padding: '11px 16px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#111827',
    color: '#ffffff',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  },
  cancelBtn: {
    width: '100%',
    marginTop: 10,
    padding: '9px 16px',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    backgroundColor: 'transparent',
    color: '#6b7280',
    fontSize: 13,
    cursor: 'pointer',
  },
  errorBox: {
    padding: '10px 12px',
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#991b1b',
    fontSize: 13,
    marginBottom: 12,
  },
  infoBox: {
    padding: '10px 12px',
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    border: '1px solid #bfdbfe',
    color: '#1e40af',
    fontSize: 13,
    marginBottom: 12,
  },
  successBox: {
    padding: '10px 12px',
    borderRadius: 8,
    backgroundColor: '#f0fdf4',
    border: '1px solid #bbf7d0',
    color: '#166534',
    fontSize: 13,
    marginBottom: 12,
  },
};

export default SMPGCheckoutBox;
