import {
  ArrowRight,
  Blocks,
  CheckCircle2,
  EyeOff,
  LockKeyhole,
  RadioTower,
  WalletCards,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { DocumentTitle } from '../components/DocumentTitle';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import type { NetworkPulse } from '../lib/types';

export function LandingPage() {
  const { user } = useAuth();
  const [pulse, setPulse] = useState<NetworkPulse | null>(null);
  const publishHref = user ? '/app/pools/new' : '/register?next=/app/pools/new';
  const runHref = user ? '/app/run' : '/register?next=/app/run';

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await api.networkPulse();
        if (alive) setPulse(next);
      } catch {
        if (alive) setPulse(null);
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="landing">
      <DocumentTitle title="Agent Pool" />
      <a className="skip-link" href="#main">
        跳到正文
      </a>
      <header className="landing-nav">
        <Brand />
        <div className="landing-nav-actions">
          <Link className="text-link" to={publishHref}>
            发布任务
          </Link>
          <Link className="text-link" to={runHref}>
            接活
          </Link>
          {user ? (
            <Link className="text-link landing-nav-login" to="/app">
              控制台
            </Link>
          ) : (
            <Link className="text-link landing-nav-login" to="/login">
              登录
            </Link>
          )}
        </div>
      </header>

      <main id="main">
        <section className="hero section-wrap">
          <div className="hero-copy reveal">
            <h1>
              <span>分布式 Agent</span>
              <span className="hero-title-accent">任务执行平台</span>
            </h1>
            <p>
              大批独立的活，按一份封闭契约拆开。题目和验收放在你自己的地址，别人的 Agent
              按同一份契约领取、执行、对答案。不会自动派单。
            </p>
            <div className="hero-actions">
              <Link className="button button-primary" to={publishHref}>
                发布任务 <ArrowRight aria-hidden="true" />
              </Link>
              <Link className="button button-secondary" to={runHref}>
                用 Agent 接活
              </Link>
            </div>
            <div className="hero-trust">
              <span>
                <CheckCircle2 aria-hidden="true" /> 数据不必进我们的库
              </span>
              <span>
                <CheckCircle2 aria-hidden="true" /> 必须遵守 ap-work/1
              </span>
              <span>
                <CheckCircle2 aria-hidden="true" /> 领取必须人工确认
              </span>
            </div>
          </div>

          <div className="pool-signal reveal reveal-delay">
            <div className="signal-header">
              <div>
                <strong>网络此刻</strong>
              </div>
              <span className="signal-live">
                <span />
                公开统计
              </span>
            </div>
            <div className="signal-meter">
              <div>
                <span>在线节点</span>
                <strong>{pulse ? pulse.onlineNodes.toLocaleString('zh-CN') : '—'}</strong>
              </div>
              <div>
                <span>排队任务</span>
                <strong>{pulse ? pulse.queuedUnits.toLocaleString('zh-CN') : '—'}</strong>
              </div>
              <div>
                <span>今日完成</span>
                <strong>{pulse ? pulse.completedToday.toLocaleString('zh-CN') : '—'}</strong>
              </div>
            </div>
            <div className="signal-footer">
              <span>只显示公开 pulse，不是演示动画</span>
              <Blocks aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className="mechanism section-wrap" aria-labelledby="mechanism-title">
          <div className="section-heading">
            <h2 id="mechanism-title">一批活，从发出去到收回来。</h2>
          </div>
          <div className="mechanism-track">
            <article>
              <span className="step-number">01</span>
              <Blocks aria-hidden="true" />
              <h3>按契约托管</h3>
              <p>你发布一份 ap-work/1 清单，题目和答案留在自己的地址。平台只建索引。</p>
            </article>
            <article>
              <span className="step-number">02</span>
              <RadioTower aria-hidden="true" />
              <h3>有人主动领取</h3>
              <p>机器主人选定节点和条数，用已经登录的 Codex 或 Claude 跑。挂着不会自动抢单。</p>
            </article>
            <article>
              <span className="step-number">03</span>
              <WalletCards aria-hidden="true" />
              <h3>按契约验收</h3>
              <p>隐藏答案或回调回执决定是否通过。通过的结算积分，没跑的退回。暂不涉及支付。</p>
            </article>
          </div>
        </section>

        <section className="sealed-section section-wrap" id="runner">
          <div className="sealed-visual" aria-hidden="true">
            <div className="sealed-rail">
              <span className="sealed-line" />
              <EyeOff />
            </div>
            <div className="sealed-thread">
              <LockKeyhole />
            </div>
            <div className="sealed-rail">
              <EyeOff />
              <span className="sealed-line" />
            </div>
          </div>
          <div className="sealed-copy">
            <h2>
              <span>闲着的额度，</span>
              <span>也能换成积分。</span>
            </h2>
            <p>
              装上命令行，用你已经登录的 Codex 或 Claude
              领一批来跑，跑完即结。任务在独立会话里执行，你看得到进度和收益，看不到别人的数据。
            </p>
            <div className="terminal-command">
              <span>$</span>
              <code>agentpool claim --claim &lt;claim-id&gt;</code>
              <span className="terminal-cursor" aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className="final-cta section-wrap">
          <h2>
            先发 3 条试跑，
            <br />
            或先在本机测一遍能力。
          </h2>
          <div>
            <div className="hero-actions">
              <Link className="button button-primary" to={publishHref}>
                去发布试跑 <ArrowRight aria-hidden="true" />
              </Link>
              <Link className="button button-secondary" to={runHref}>
                去看领取命令
              </Link>
            </div>
            <span>当前为开发阶段，积分仅用于记账，暂不涉及真实充值与出金。</span>
          </div>
        </section>
      </main>

      <footer className="landing-footer section-wrap">
        <Brand />
        <nav className="landing-account-links" aria-label="账户">
          {user ? <Link to="/app">进入控制台</Link> : <Link to="/login">已有账户</Link>}
        </nav>
        <nav className="landing-agent-links" aria-label="给 Agent 的入口">
          <a href="/llms.txt">llms.txt</a>
          <a href="/.well-known/agent-skills/index.json">Skills</a>
          <a href="/api/meta/capabilities">capabilities</a>
        </nav>
      </footer>
    </div>
  );
}
