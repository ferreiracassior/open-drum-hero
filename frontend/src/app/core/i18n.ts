import { signal } from '@angular/core';
import { STRINGS } from './strings';

/**
 * App language (English is the default; Portuguese is the alternative). The choice is saved on the device.
 * `t('key', { name: value })` returns the text in the current language; in templates, reading `t()` makes the screen
 * redraw by itself when the language changes (the language is a signal).
 */
export type Lang = 'en' | 'pt';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'pt', label: 'Português' },
];

const KEY = 'drumhero.lang';

function readLang(): Lang {
  try { return localStorage.getItem(KEY) === 'pt' ? 'pt' : 'en'; } catch { return 'en'; }
}

export const lang = signal<Lang>(readLang());
applyDocumentLang(lang());

export function setLang(l: Lang): void {
  lang.set(l);
  try { localStorage.setItem(KEY, l); } catch { /* no storage */ }
  applyDocumentLang(l);
}

function applyDocumentLang(l: Lang): void {
  try { document.documentElement.lang = l === 'pt' ? 'pt-BR' : 'en'; } catch { /* outside the browser */ }
  // apk: the Android side (errors, Songsterr window) speaks the same language
  try {
    const native = (window as { Capacitor?: { Plugins?: Record<string, { setLang?: (o: { lang: Lang }) => Promise<void> }> } }).Capacitor;
    void native?.Plugins?.['DrumHero']?.setLang?.({ lang: l })?.catch(() => {});
  } catch { /* no plugin */ }
}

export type StringKey = keyof typeof STRINGS;

export function t(key: StringKey, params?: Record<string, string | number>): string {
  const entry = STRINGS[key] as { en: string; pt: string } | undefined;
  let s = entry ? entry[lang()] ?? entry.en : String(key);
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Simple singular/plural: `plural(n, 'song.one', 'song.many')`. */
export function plural(n: number, one: StringKey, many: StringKey, params?: Record<string, string | number>): string {
  return t(n === 1 ? one : many, { n, ...params });
}
