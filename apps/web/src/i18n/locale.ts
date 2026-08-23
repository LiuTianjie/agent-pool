export const LOCALES = ['zh', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = 'agent-pool.locale';

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'zh' || value === 'en';
}

export function intlLocale(locale: Locale): string {
  return locale === 'en' ? 'en-US' : 'zh-CN';
}

export function htmlLang(locale: Locale): string {
  return locale === 'en' ? 'en' : 'zh-CN';
}

export function ogLocale(locale: Locale): string {
  return locale === 'en' ? 'en_US' : 'zh_CN';
}

export function detectLocale(search = ''): Locale {
  const query = new URLSearchParams(search).get('lang');
  if (isLocale(query)) return query;

  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(stored)) return stored;
    } catch {
      // Private mode or blocked storage should not break first paint.
    }
    if (import.meta.env.MODE === 'test') return 'zh';
    const language = (window.navigator.language || '').toLowerCase();
    if (language.startsWith('zh')) return 'zh';
    if (language.startsWith('en')) return 'en';
  }

  return 'zh';
}

export function persistLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore quota / privacy errors.
  }
}

export function listJoin(items: string[], locale: Locale): string {
  return locale === 'zh' ? items.join('、') : items.join(', ');
}

let activeLocale: Locale = 'zh';

export function getLocale(): Locale {
  return activeLocale;
}

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}
