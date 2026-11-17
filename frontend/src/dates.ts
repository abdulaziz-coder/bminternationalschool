import type { Locale } from './translations';

// Browsers on many devices have no Uzbek month names and print "2026 M11 14", so Uzbek dates are written here.
const uzbekMonths = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

/** A date such as "14 November 2026", "14-noyabr, 2026", or "14 ноября 2026 г." in the visitor's language. */
export function longDate(locale: Locale, value: string): string {
  const date = new Date(value);
  if (locale === 'uz') return `${date.getDate()}-${uzbekMonths[date.getMonth()]}, ${date.getFullYear()}`;
  return new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}