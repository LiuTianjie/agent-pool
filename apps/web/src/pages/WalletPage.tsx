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
import { EmptyState, InlineError, LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { WalletGrid } from '../components/WalletGrid';
import { api, ApiError, normalizeList } from '../lib/api';
import { credits, fullDateTime } from '../lib/format';
import type { LedgerEntry } from '../lib/types';

const TOP_UP_OPTIONS = [1_000, 5_000, 20_000, 100_000];

const ENTRY_LABEL: Record<LedgerEntry['kind'], string> = {
  topup: '增加积分',
  lock: '发布任务锁定',
  unlock: '未执行积分解锁',
  self_settlement: '自己跑通',
  earning_pending: '交付待结算',
  earning_settled: '收益已结算',
  withdrawal: '提现',
  adjustment: '账本调整',
};

const BUCKET_LABEL: Record<keyof WalletSummary, string> = {
  purchasedAvailable: '可消费',
  purchasedLocked: '任务锁定',
  earnedPending: '待结算收益',
  earnedAvailable: '可提现收益',
};

export function WalletPage() {
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [walletResult, ledgerResult] = await Promise.all([api.wallet(), api.ledger()]);
      setWallet(walletResult);
      setEntries(normalizeList(ledgerResult));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '无法读取积分');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const topUp = async () => {
    if (topUpAmount < 1 || topUpAmount > 1_000_000) {
      setError('一次可以增加 1–1,000,000 积分');
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
      setError(requestError instanceof ApiError ? requestError.message : '增加积分失败');
    } finally {
      setToppingUp(false);
    }
  };

  const withdraw = async () => {
    if (!wallet) return;
    if (withdrawAmount < 1 || withdrawAmount > wallet.earnedAvailable) {
      setError('只能从可提现收益中选择有效数量');
      return;
    }
    setWithdrawing(true);
    setError(null);
    try {
      const result = await api.devWithdraw(Math.trunc(withdrawAmount));
      setWallet(result.wallet);
      setWithdrawalNotice('已记下一笔提现，没有真实打款。');
      setWithdrawOpen(false);
      setEntries(normalizeList(await api.ledger()));
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '模拟提现失败');
    } finally {
      setWithdrawing(false);
    }
  };

  if (loading && !wallet) return <LoadingState label="正在读取积分" />;
  if (error && !wallet) return <InlineError message={error} retry={() => void load()} />;
  if (!wallet) return null;

  return (
    <div className="page wallet-page">
      <PageHeader
        eyebrow="积分"
        title="积分"
        description="发布任务用可消费积分，做完任务赚到的进收益。现在还不是真钱。"
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
              <ArrowUpFromLine aria-hidden="true" /> 提现
            </button>
            <button
              className="button button-primary"
              type="button"
              onClick={() => setTopUpOpen(true)}
            >
              <Plus aria-hidden="true" /> 增加积分
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
            <h2>增加的积分</h2>
            <p>用来发布任务，不能转给别人，也不能提现。</p>
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
            <h2>赚来的积分</h2>
            <p>任务通过后先待结算，再进入可提现。</p>
          </div>
        </article>
      </section>

      <section className="ledger-section page-section">
        <div className="section-bar">
          <div>
            <h2>最近账目</h2>
          </div>
          <span>{entries.length} 笔</span>
        </div>
        {entries.length ? (
          <div className="ledger-table" role="table" aria-label="积分流水">
            <div className="ledger-head" role="row">
              <span>类型</span>
              <span>说明</span>
              <span>账户</span>
              <span>时间</span>
              <span>金额</span>
            </div>
            {entries.map((entry) => (
              <div className="ledger-row" role="row" key={entry.id}>
                <span className={`ledger-kind ledger-${entry.kind}`}>
                  <ReceiptText aria-hidden="true" /> {ENTRY_LABEL[entry.kind]}
                </span>
                <div>
                  <strong>{entry.description}</strong>
                  {entry.referenceId ? <small>REF / {entry.referenceId.slice(0, 12)}</small> : null}
                </div>
                <span>{BUCKET_LABEL[entry.balanceBucket]}</span>
                <time dateTime={entry.createdAt}>{fullDateTime(entry.createdAt)}</time>
                <strong className={entry.amount >= 0 ? 'amount-positive' : 'amount-negative'}>
                  {entry.amount >= 0 ? '+' : ''}
                  {credits(entry.amount)}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="账本还是空的"
            detail="增加积分或做完第一条任务后，流水会出现在这里。"
          />
        )}
      </section>

      <aside className="dev-money-note">
        <Info aria-hidden="true" />
        <p>
          <strong>现在还不是真钱。</strong>增加和提现都只记账，充值和收益分开算。
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
            <h2 id="topup-title">增加积分</h2>
            <p>现在只是记账，这些积分只能用来发布任务。</p>
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
              <span>自定义数量</span>
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
              <span>加进来的积分不能提现。</span>
            </div>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setTopUpOpen(false)}
              >
                取消
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={toppingUp}
                onClick={() => void topUp()}
              >
                {toppingUp ? '正在入账…' : `增加 ${credits(topUpAmount)}`}
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
            <h2 id="withdraw-title">提现收益</h2>
            <p>现在只从可提现收益里扣一笔账，不会打到银行卡。</p>
            <label className="field">
              <span>从可提现收益扣减</span>
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
              <small>当前最多 {credits(wallet.earnedAvailable)}。用来发布的积分不能提现。</small>
            </label>
            <div className="topup-assurance">
              <ShieldCheck aria-hidden="true" />
              <span>这是演示提现，用来看账怎么走。</span>
            </div>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setWithdrawOpen(false)}
              >
                取消
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={
                  withdrawing || withdrawAmount < 1 || withdrawAmount > wallet.earnedAvailable
                }
                onClick={() => void withdraw()}
              >
                {withdrawing ? '正在处理…' : `提现 ${credits(withdrawAmount)}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
