import type { WalletSummary } from '@agent-pool/shared';
import { ArrowDownToLine, LockKeyhole, Wallet } from 'lucide-react';
import { credits } from '../lib/format';

const ITEMS: Array<{
  key: keyof WalletSummary;
  label: string;
  note: string;
  icon: typeof Wallet;
  tone: string;
}> = [
  { key: 'purchasedAvailable', label: '可消费', note: '用于发布任务', icon: Wallet, tone: 'lime' },
  {
    key: 'purchasedLocked',
    label: '任务锁定',
    note: '等待执行或验收',
    icon: LockKeyhole,
    tone: 'neutral',
  },
  {
    key: 'earnedAvailable',
    label: '可转出收益',
    note: '开发期仅记账',
    icon: ArrowDownToLine,
    tone: 'white',
  },
];

function PendingNote({ wallet }: { wallet: WalletSummary }) {
  return <p className="wallet-pending-note">待结算收益 {credits(wallet.earnedPending)}</p>;
}

export function WalletGrid({
  wallet,
  compact = false,
  variant = 'grid',
}: {
  wallet: WalletSummary;
  compact?: boolean;
  variant?: 'grid' | 'strip';
}) {
  if (variant === 'strip') {
    return (
      <div className="wallet-strip-wrap">
        <div className="wallet-strip" aria-label="积分">
          {ITEMS.map(({ key, label }) => (
            <span key={key}>
              {label} <strong>{credits(wallet[key])}</strong>
            </span>
          ))}
        </div>
        <PendingNote wallet={wallet} />
      </div>
    );
  }

  return (
    <div className="wallet-grid-wrap">
      <div className={compact ? 'wallet-grid wallet-grid-compact' : 'wallet-grid'}>
        {ITEMS.map(({ key, label, note, icon: Icon, tone }) => (
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
      <PendingNote wallet={wallet} />
    </div>
  );
}
