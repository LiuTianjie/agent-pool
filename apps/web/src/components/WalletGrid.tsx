import type { WalletSummary } from '@agent-pool/shared';
import { ArrowDownToLine, LockKeyhole, Wallet } from 'lucide-react';
import { useI18n } from '../i18n';
import { credits } from '../lib/format';

export function WalletGrid({
  wallet,
  compact = false,
  variant = 'grid',
}: {
  wallet: WalletSummary;
  compact?: boolean;
  variant?: 'grid' | 'strip';
}) {
  const { t } = useI18n();
  const items = [
    {
      key: 'purchasedAvailable' as const,
      label: t('wallet.gridSpendable'),
      note: t('wallet.gridSpendableNote'),
      icon: Wallet,
      tone: 'lime',
    },
    {
      key: 'purchasedLocked' as const,
      label: t('wallet.gridLocked'),
      note: t('wallet.gridLockedNote'),
      icon: LockKeyhole,
      tone: 'neutral',
    },
    {
      key: 'earnedAvailable' as const,
      label: t('wallet.gridWithdrawable'),
      note: t('wallet.gridWithdrawableNote'),
      icon: ArrowDownToLine,
      tone: 'white',
    },
  ];

  if (variant === 'strip') {
    return (
      <div className="wallet-strip-wrap">
        <div className="wallet-strip" aria-label={t('wallet.creditsAria')}>
          {items.map(({ key, label }) => (
            <span key={key}>
              {label} <strong>{credits(wallet[key])}</strong>
            </span>
          ))}
        </div>
        <p className="wallet-pending-note">
          {t('wallet.pendingNote', { amount: credits(wallet.earnedPending) })}
        </p>
      </div>
    );
  }

  return (
    <div className="wallet-grid-wrap">
      <div className={compact ? 'wallet-grid wallet-grid-compact' : 'wallet-grid'}>
        {items.map(({ key, label, note, icon: Icon, tone }) => (
          <article className={`wallet-card wallet-${tone}`} key={key}>
            <div>
              <span>{label}</span>
              <Icon aria-hidden="true" />
            </div>
            <strong>{credits(wallet[key])}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>
      <p className="wallet-pending-note">
        {t('wallet.pendingNote', { amount: credits(wallet.earnedPending) })}
      </p>
    </div>
  );
}
