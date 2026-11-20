type Language = 'uz' | 'en' | 'ru';

/** Which language's name to show when the reader's language has none: the same order as notices use. */
const nameFallback = { uz: ['uz', 'ru', 'en'], ru: ['ru', 'uz', 'en'], en: ['en', 'uz', 'ru'] } as const;

/** A subject's name in the given language, or in the nearest language it has, or its main name. */
export function subjectLabel(item: { name: string; names: Partial<Record<Language, string>> }, locale: Language) {
  for (const language of nameFallback[locale]) { const name = item.names[language]; if (name) return name; }
  return item.name;
}
