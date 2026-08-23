import { Radio } from 'lucide-react';
import { useI18n } from '../i18n';

function withEllipsis(label: string) {
  if (label.endsWith('…')) return label;
  if (label.endsWith('...')) return `${label.slice(0, -3)}…`;
  return `${label}…`;
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="loading-state" role="status">
      <Radio aria-hidden="true" />
      <span>{withEllipsis(label ?? t('common.loading'))}</span>
    </div>
  );
}

export function InlineError({
  message,
  title,
  retry,
}: {
  message: string;
  title?: string;
  retry?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="inline-error" role="alert">
      <div>
        <strong>{title ?? (retry ? t('common.cannotRead') : t('common.cannotContinue'))}</strong>
        <p>{message}</p>
      </div>
      {retry ? (
        <button className="button button-quiet" type="button" onClick={retry}>
          {t('common.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-node" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}
