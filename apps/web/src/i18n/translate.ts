import { catalog, isCatalogLeaf } from './catalog';
import { getLocale, type Locale } from './locale';

export type TranslateParams = Record<string, string | number>;

type CatalogNode = typeof catalog;

type MessageKeyOf<T> = T extends { zh: string; en: string }
  ? never
  : {
      [K in keyof T & string]: T[K] extends { zh: string; en: string }
        ? K
        : `${K}.${MessageKeyOf<T[K]>}`;
    }[keyof T & string];

export type MessageKey = MessageKeyOf<CatalogNode>;

export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function lookupMessage(key: string, locale: Locale = getLocale()): string {
  const parts = key.split('.');
  let current: unknown = catalog;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return key;
    current = (current as Record<string, unknown>)[part];
  }
  if (!isCatalogLeaf(current)) return key;
  return current[locale] || current.zh || key;
}

export function t(key: MessageKey, params?: TranslateParams): string {
  return interpolate(lookupMessage(key), params);
}

export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  return interpolate(lookupMessage(key, locale), params);
}
