import { getLocale, intlLocale } from '../i18n/locale';
import { t } from '../i18n/translate';

export function formatInteger(value: number): string {
  return new Intl.NumberFormat(intlLocale(getLocale())).format(value);
}

export function credits(value: number): string {
  return t('format.credits', { value: formatInteger(value) });
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(intlLocale(getLocale()), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(getLocale()), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function fullDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(getLocale()), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function credentialDate(value: string | null): string {
  if (!value) return t('format.neverUsed');
  return new Intl.DateTimeFormat(intlLocale(getLocale()), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function relativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.round((time - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(intlLocale(getLocale()), { numeric: 'auto' });
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
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
    return t('format.noData');
  if (seconds < 60) return t('format.seconds', { n: Math.ceil(seconds) });
  if (seconds < 3600) return t('format.minutes', { n: Math.ceil(seconds / 60) });
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return minutes
    ? t('format.hoursMinutes', { h: hours, m: minutes })
    : t('format.hours', { n: hours });
}

const CAPACITY_REASON_KEYS = {
  CERTIFIED_CONCURRENCY_INSUFFICIENT: 'format.certifiedConcurrency',
  ONLINE_CONCURRENCY_INSUFFICIENT: 'format.onlineConcurrency',
  AVAILABLE_CONCURRENCY_INSUFFICIENT: 'format.availableConcurrency',
  NO_VALID_PERFORMANCE_CERTIFICATION: 'format.noCertification',
  P95_EXCEEDS_UNIT_LIMIT: 'format.p95Exceeds',
  DEADLINE_ALREADY_PASSED: 'format.deadlinePassed',
  DEADLINE_NOT_FEASIBLE: 'format.deadlineUnfeasible',
} as const;

export function capacityReason(reason: string): string {
  const key = CAPACITY_REASON_KEYS[reason as keyof typeof CAPACITY_REASON_KEYS];
  return key ? t(key) : reason;
}
