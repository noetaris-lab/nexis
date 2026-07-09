// i18n locale registry for the nexis wiki. Rewritten wholesale by
// /nexis:wiki-translate when a locale is added — do not hand-edit, your
// changes are overwritten on the next `--lang` run.
//
// `root` is Starlight's reserved key for the default locale: its pages keep
// their existing unprefixed paths, so turning on i18n never moves anything.
export const defaultLocale = 'root';
export const locales = {
  root: { label: '__DEFAULT_LOCALE_LABEL__', lang: '__DEFAULT_LOCALE_CODE__' },
};
