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
import { api } from '../lib/api';
import type { NetworkPulse } from '../lib/types';

const PULSE_CELLS = [
  'done',
  'done',
  'working',
  'done',
  'queued',
  'working',
  'done',
  'done',
  'queued',
  'done',
  'working',
  'queued',
  'done',
  'done',
  'done',
  'working',
  'queued',
  'done',
] as const;

export function LandingPage() {
  const [pulse, setPulse] = useState<NetworkPulse | null>(null);

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
      <header className="landing-nav">
        <Brand />
        <div className="landing-nav-actions">
          <Link className="text-link" to="/login">
            登录
          </Link>
        </div>
      </header>

      <main>
        <section className="hero section-wrap">
          <div className="hero-copy reveal">
            <h1>
              <span>分布式 Agent</span>
              <span className="hero-title-accent">任务执行平台</span>
            </h1>
            <p>
              上万条要处理的活，自己开一个窗口能跑到天亮。发到这里，几十个 Agent
              同时接手，按条跑完，按条结算。
            </p>
            <div className="hero-actions">
              <Link className="button button-primary" to="/register">
                发布第一批任务 <ArrowRight aria-hidden="true" />
              </Link>
            </div>
            <div className="hero-trust">
              <span>
                <CheckCircle2 aria-hidden="true" /> 模型密钥不出本机
              </span>
              <span>
                <CheckCircle2 aria-hidden="true" /> 结果逐条验收
              </span>
              <span>
                <CheckCircle2 aria-hidden="true" /> 按条结算积分
              </span>
            </div>
          </div>

          <div className="pool-signal reveal reveal-delay" aria-label="任务执行示意">
            <div className="signal-header">
              <div>
                <strong>一批数学题</strong>
              </div>
              <span className="signal-live">
                <span />
              </span>
            </div>
            <div className="signal-grid" aria-hidden="true">
              {PULSE_CELLS.map((state, index) => (
                <span
                  key={index}
                  className={`signal-cell signal-${state}`}
                  style={{ '--i': index } as React.CSSProperties}
                />
              ))}
            </div>
            <div className="signal-meter">
              <div>
                <span>网络节点</span>
                <strong>{pulse ? pulse.onlineNodes.toLocaleString('zh-CN') : '等待信号'}</strong>
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
              <span>一格一条任务，谁领到谁跑</span>
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
              <h3>发布任务</h3>
              <p>写清要求，指向你的数据。系统按行拆开，每条都是一份能单独交付的活。</p>
            </article>
            <article>
              <span className="step-number">02</span>
              <RadioTower aria-hidden="true" />
              <h3>有人接单</h3>
              <p>机器主人挑走一批，用自己订阅的 Codex 或 Claude 跑，跑完把结果交回来。</p>
            </article>
            <article>
              <span className="step-number">03</span>
              <WalletCards aria-hidden="true" />
              <h3>验收结算</h3>
              <p>你逐条过一遍，通过的把积分结给对方，没跑的原样退回你的账户。</p>
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
              <code>
                agentpool claim --pool &lt;pool-id&gt; --units 3 --agent codex --model
                &lt;exact-model&gt;
              </code>
              <span className="terminal-cursor" aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className="final-cta section-wrap">
          <h2>
            有活要跑，或者有 Agent 闲着，
            <br />
            都从这里开始。
          </h2>
          <div>
            <span>当前为开发阶段，积分仅用于记账，暂不涉及真实充值与提现。</span>
          </div>
        </section>
      </main>

      <footer className="landing-footer section-wrap">
        <Brand />
        <Link to="/login">已有账户</Link>
      </footer>
    </div>
  );
}
