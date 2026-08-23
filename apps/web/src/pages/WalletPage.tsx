import type { WalletSummary } from '@agent-pool/shared';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowUpFromLine,
  CircleDollarSign,
  Info,
  LockKeyhole,
  Plus,
  ReceiptText,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DocumentTitle } from '../components/DocumentTitle';
import { EmptyState, InlineError, LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { WalletGrid } from '../components/WalletGrid';
import { useI18n } from '../i18n';
import { api, ApiError, normalizeList } from '../lib/api';
import { credits, fullDateTime } from '../lib/format';
import type { LedgerEntry } from '../lib/types';

const TOP_UP_OPTIONS = [1_000, 5_000, 20_000, 100_000];

export function WalletPage() {
  const { t } = useI18n();
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState(5_000);
  const [toppingUp, setToppingUp] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState(1);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawalNotice, setWithdrawalNotice] = useState<string | null>(null);

  const entryLabel: Record<LedgerEntry['kind'], string> = {
    topup: t('wallet.kindTopup'),
    lock: t('wallet.kindLock'),
    unlock: t('wallet.kindUnlock'),
    self_settlement: t('wallet.kindSelf'),
    earning_pending: t('wallet.kindPending'),
    earning_settled: t('wallet.kindSettled'),
    withdrawal: t('wallet.kindWithdraw'),
    adjustment: t('wallet.kindAdjust'),
  };

  const bucketLabel: Record<keyof WalletSummary, string> = {
    purchasedAvailable: t('wallet.bucketSpendable'),
    purchasedLocked: t('wallet.bucketLocked'),
    earnedPending: t('wallet.bucketPending'),
    earnedAvailable: t('wallet.bucketWithdrawable'),
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [walletResult, ledgerResult] = await Promise.all([api.wallet(), api.ledger()]);
      setWallet(walletResult);
      setEntries(normalizeList(ledgerResult));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('wallet.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const topUp = async () => {
    if (topUpAmount < 1 || topUpAmount > 1_000_000) {
      setError(t('wallet.topupRange'));
      return;
    }
    setToppingUp(true);
    setError(null);
    try {
      setWallet(await api.devTopUp(Math.trunc(topUpAmount)));
      setTopUpOpen(false);
      const ledgerResult = await api.ledger();
      setEntries(normalizeList(ledgerResult));
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : t('wallet.topupFailed'));
    } finally {
      setToppingUp(false);
    }
  };

  const withdraw = async () => {
    if (!wallet) return;
    if (withdrawAmount < 1 || withdrawAmount > wallet.earnedAvailable) {
      setError(t('wallet.withdrawRange'));
      return;
    }
    setWithdrawing(true);
    setError(null);
    try {
      const result = await api.devWithdraw(Math.trunc(withdrawAmount));
      setWallet(result.wallet);
      setWithdrawalNotice(t('wallet.withdrawNotice'));
      setWithdrawOpen(false);
      setEntries(normalizeList(await api.ledger()));
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : t('wallet.withdrawFailed'),
      );
    } finally {
      setWithdrawing(false);
    }
  };

  if (loading && !wallet) return <LoadingState label={t('wallet.loading')} />;
  if (error && !wallet) return <InlineError message={error} retry={() => void load()} />;
  if (!wallet) return null;

  return (
    <div className="page wallet-page">
      <DocumentTitle title={t('wallet.title')} />
      <PageHeader
        eyebrow={t('wallet.title')}
        title={t('wallet.heading')}
        description={t('wallet.description')}
        actions={
          <>
            <button
              className="button button-outline"
              type="button"
              disabled={wallet.earnedAvailable < 1}
              onClick={() => {
                setWithdrawAmount(Math.max(1, wallet.earnedAvailable));
                setWithdrawOpen(true);
              }}
            >
              <ArrowUpFromLine aria-hidden="true" /> {t('wallet.withdraw')}
            </button>
            <button
              className="button button-primary"
              type="button"
              onClick={() => setTopUpOpen(true)}
            >
              <Plus aria-hidden="true" /> {t('wallet.topup')}
            </button>
          </>
        }
      />
      {error ? <InlineError message={error} /> : null}
      {withdrawalNotice ? (
        <div className="success-notice" role="status">
          {withdrawalNotice}
        </div>
      ) : null}
      <WalletGrid wallet={wallet} />

      <section className="money-boundary">
        <article>
          <span className="money-icon">
            <ArrowDownLeft aria-hidden="true" />
          </span>
          <div>
            <h2>{t('wallet.addedTitle')}</h2>
            <p>{t('wallet.addedBody')}</p>
          </div>
        </article>
        <span className="boundary-divider">
          <LockKeyhole aria-hidden="true" />
        </span>
        <article>
          <span className="money-icon money-icon-warm">
            <ArrowUpRight aria-hidden="true" />
          </span>
          <div>
            <h2>{t('wallet.earnedTitle')}</h2>
            <p>{t('wallet.earnedBody')}</p>
          </div>
        </article>
      </section>

      <section className="ledger-section page-section">
        <div className="section-bar">
          <div>
            <h2>{t('wallet.recent')}</h2>
          </div>
          <span>{t('wallet.entryCount', { count: entries.length })}</span>
        </div>
        {entries.length ? (
          <div className="ledger-table" role="table" aria-label={t('wallet.tableAria')}>
            <div className="ledger-head" role="row">
              <span>{t('wallet.colType')}</span>
              <span>{t('wallet.colNote')}</span>
              <span>{t('wallet.colBucket')}</span>
              <span>{t('wallet.colTime')}</span>
              <span>{t('wallet.colAmount')}</span>
            </div>
            {entries.map((entry) => (
              <div className="ledger-row" role="row" key={entry.id}>
                <span className={`ledger-kind ledger-${entry.kind}`}>
                  <ReceiptText aria-hidden="true" /> {entryLabel[entry.kind]}
                </span>
                <div>
                  <strong>{entry.description}</strong>
                  {entry.referenceId ? <small>REF / {entry.referenceId.slice(0, 12)}</small> : null}
                </div>
                <span>{bucketLabel[entry.balanceBucket]}</span>
                <time dateTime={entry.createdAt}>{fullDateTime(entry.createdAt)}</time>
                <strong className={entry.amount >= 0 ? 'amount-positive' : 'amount-negative'}>
                  {entry.amount >= 0 ? '+' : ''}
                  {credits(entry.amount)}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title={t('wallet.emptyTitle')} detail={t('wallet.emptyDetail')} />
        )}
      </section>

      <aside className="dev-money-note">
        <Info aria-hidden="true" />
        <p>
          <strong>{t('wallet.devNoteTitle')}</strong> {t('wallet.devNote')}
        </p>
      </aside>

      {topUpOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setTopUpOpen(false)}
        >
          <section
            className="dialog topup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topup-title"
          >
            <div className="dialog-icon dialog-icon-lime">
              <WalletCards aria-hidden="true" />
            </div>
            <h2 id="topup-title">{t('wallet.topupTitle')}</h2>
            <p>{t('wallet.topupLead')}</p>
            <div className="topup-options">
              {TOP_UP_OPTIONS.map((amount) => (
                <button
                  type="button"
                  className={topUpAmount === amount ? 'active' : ''}
                  onClick={() => setTopUpAmount(amount)}
                  key={amount}
                >
                  {credits(amount)}
                </button>
              ))}
            </div>
            <label className="field">
              <span>{t('wallet.customAmount')}</span>
              <span className="input-shell">
                <CircleDollarSign aria-hidden="true" />
                <input
                  type="number"
                  min={1}
                  max={1_000_000}
                  value={topUpAmount}
                  onChange={(event) => setTopUpAmount(Number(event.target.value))}
                />
              </span>
            </label>
            <div className="topup-assurance">
              <ShieldCheck aria-hidden="true" />
              <span>{t('wallet.topupLock')}</span>
            </div>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setTopUpOpen(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={toppingUp}
                onClick={() => void topUp()}
              >
                {toppingUp
                  ? t('wallet.topping')
                  : t('wallet.topupAction', { amount: credits(topUpAmount) })}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {withdrawOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setWithdrawOpen(false)}
        >
          <section
            className="dialog topup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="withdraw-title"
          >
            <div className="dialog-icon dialog-icon-lime">
              <ArrowUpFromLine aria-hidden="true" />
            </div>
            <h2 id="withdraw-title">{t('wallet.withdrawTitle')}</h2>
            <p>{t('wallet.withdrawLead')}</p>
            <label className="field">
              <span>{t('wallet.withdrawFrom')}</span>
              <span className="input-shell">
                <CircleDollarSign aria-hidden="true" />
                <input
                  type="number"
                  min={1}
                  max={wallet.earnedAvailable}
                  value={withdrawAmount}
                  onChange={(event) => setWithdrawAmount(Number(event.target.value))}
                />
              </span>
              <small>{t('wallet.withdrawMax', { amount: credits(wallet.earnedAvailable) })}</small>
            </label>
            <div className="topup-assurance">
              <ShieldCheck aria-hidden="true" />
              <span>{t('wallet.withdrawDemo')}</span>
            </div>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setWithdrawOpen(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={
                  withdrawing || withdrawAmount < 1 || withdrawAmount > wallet.earnedAvailable
                }
                onClick={() => void withdraw()}
              >
                {withdrawing
                  ? t('wallet.withdrawing')
                  : t('wallet.withdrawAction', { amount: credits(withdrawAmount) })}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
