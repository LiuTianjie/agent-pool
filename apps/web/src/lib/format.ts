import { formatCredits } from '@agent-pool/shared';

export function credits(value: number): string {
  return `${formatCredits(value)} 积分`;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function fullDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function relativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.round((time - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  if (absolute < 60) return formatter.format(seconds, 'second');
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86_400), 'day');
}

export function percent(value: number): string {
  const normalized = value > 1 ? value : value * 100;
  return `${Math.round(normalized * 10) / 10}%`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '暂无数据';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

const CAPACITY_REASON_LABELS: Record<string, string> = {
  CERTIFIED_CONCURRENCY_INSUFFICIENT: '现在能同时做的人不够',
  ONLINE_CONCURRENCY_INSUFFICIENT: '现在在线能做的人不够',
  AVAILABLE_CONCURRENCY_INSUFFICIENT: '现在空闲能做的人不够',
  NO_VALID_PERFORMANCE_CERTIFICATION: '还没有这类任务的能力记录',
  P95_EXCEEDS_UNIT_LIMIT: '按以往速度，单条可能超时',
  DEADLINE_ALREADY_PASSED: '截止时间已经过了',
  DEADLINE_NOT_FEASIBLE: '按现在的速度，可能赶不及截止',
};

export function capacityReason(reason: string): string {
  return CAPACITY_REASON_LABELS[reason] || reason;
}
