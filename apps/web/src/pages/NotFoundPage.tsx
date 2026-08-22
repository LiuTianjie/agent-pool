import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { DocumentTitle } from '../components/DocumentTitle';

export function NotFoundPage() {
  return (
    <main className="not-found">
      <DocumentTitle title="未找到" />
      <Brand />
      <span>404 / 没有这个页面</span>
      <h1>这个工作单元不存在。</h1>
      <Link className="button button-primary" to="/">
        <ArrowLeft aria-hidden="true" /> 返回网络入口
      </Link>
    </main>
  );
}
