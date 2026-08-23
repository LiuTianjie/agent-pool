import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';

export function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <Link className="brand" to={compact ? '/app' : '/'} aria-label={t('brand.home')}>
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
