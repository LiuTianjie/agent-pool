import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';

export function NotFoundPage() {
  return (
    <main className="not-found">
      <Brand />
      <span>404 / LOST UNIT</span>
      <h1>这个工作单元不存在。</h1>
      <Link className="button button-primary" to="/">
        <ArrowLeft aria-hidden="true" /> 返回网络入口
      </Link>
    </main>
  );
}
