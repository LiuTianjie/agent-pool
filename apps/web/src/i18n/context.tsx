import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  detectLocale,
  getLocale,
  htmlLang,
  intlLocale,
  listJoin,
  ogLocale,
  persistLocale,
  setActiveLocale,
  type Locale,
} from './locale';
import {
  t as translateActive,
  translate,
  type MessageKey,
  type TranslateParams,
} from './translate';

interface LocaleContextValue {
  locale: Locale;
  intl: string;
  setLocale(locale: Locale): void;
  t(key: MessageKey, params?: TranslateParams): string;
  join(items: string[]): string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = htmlLang(locale);
  document.documentElement.dataset.locale = locale;

  const description = translate(locale, 'meta.description');
  const ogDescription = translate(locale, 'meta.ogDescription');
  const twitterDescription = translate(locale, 'meta.twitterDescription');
  const setMeta = (selector: string, content: string, attribute = 'content') => {
    document.querySelector(selector)?.setAttribute(attribute, content);
  };
  setMeta('meta[name="description"]', description);
  setMeta('meta[property="og:description"]', ogDescription);
  setMeta('meta[name="twitter:description"]', twitterDescription);
  setMeta('meta[property="og:locale"]', ogLocale(locale));
}

export function LocaleProvider({ children }: PropsWithChildren) {
  const location = useLocation();
  const [locale, setLocaleState] = useState<Locale>(() => {
    const next = detectLocale(location.search);
    setActiveLocale(next);
    return next;
  });

  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    persistLocale(next);
    applyDocumentLocale(next);
    setLocaleState(next);
  }, []);

  useEffect(() => {
    const fromQuery = new URLSearchParams(location.search).get('lang');
    if (fromQuery === 'en' || fromQuery === 'zh') {
      if (fromQuery !== getLocale()) setLocale(fromQuery);
    }
  }, [location.search, setLocale]);

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      intl: intlLocale(locale),
      setLocale,
      t: (key, params) => translate(locale, key, params),
      join: (items) => listJoin(items, locale),
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    return {
      locale: getLocale(),
      intl: intlLocale(getLocale()),
      setLocale: () => undefined,
      t: translateActive,
      join: (items) => listJoin(items, getLocale()),
    };
  }
  return context;
}
