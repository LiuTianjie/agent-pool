import { Link } from 'react-router-dom';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" to={compact ? '/app' : '/'} aria-label="Agent Pool 首页">
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        AGENT<span className="brand-separator">/</span>POOL
      </span>
    </Link>
  );
}
