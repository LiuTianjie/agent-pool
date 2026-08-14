import { Radio } from 'lucide-react';

export function LoadingState({ label = '正在同步' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <Radio aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function InlineError({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <div>
        <strong>连接中断</strong>
        <p>{message}</p>
      </div>
      {retry ? (
        <button className="button button-quiet" type="button" onClick={retry}>
          重试
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
