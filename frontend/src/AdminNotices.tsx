import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from './i18n';
import { languages, type Locale } from './translations';
import { AdminError, adminNotices, deleteNotice, pinNotice, saveNotice, type AdminNotice } from './admin-api';
import PinIcon from './PinIcon';
import { defaultCategories, distinctCategories } from './notice-categories';

type Text = { title: string; body: string };
/** The editor's working copy: every language has a slot, filled or not. */
type Draft = { category: string; labels: Record<Locale, string>; texts: Record<Locale, Text>; published: boolean; pinned: boolean };
type Errors = { category?: string; text?: string };
const codes = languages.map(language => language.code);
const each = <Value,>(make: (code: Locale) => Value) => Object.fromEntries(codes.map(code => [code, make(code)])) as Record<Locale, Value>;
const blank = (): Draft => ({ category: defaultCategories[0], labels: each(() => ''), texts: each(() => ({ title: '', body: '' })), published: true, pinned: false });
const written = (text: Text) => text.title.trim().length >= 3 && text.body.trim().length > 0;
const started = (text: Text) => !!(text.title.trim() || text.body.trim());

/** The admin tab for posting, editing, hiding, and deleting website notices in up to three languages. */
export default function AdminNotices({ onSignedOut }: { onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  // `editing` is the notice being changed, 'new' while composing one, or null when the editor is closed.
  const [editing, setEditing] = useState<AdminNotice | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminNotice | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  // The language whose title and text are on screen in the editor.
  const [language, setLanguage] = useState<Locale>(locale);
  const [errors, setErrors] = useState<Errors>({});
  // True while the admin is naming a brand-new category instead of picking an existing one.
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['admin', 'notices'], queryFn: adminNotices, retry: false, staleTime: 0 });
  const signOutIfExpired = (error: Error | null) => { if (error instanceof AdminError && error.status === 401) onSignedOut(); };
  const refresh = () => { client.invalidateQueries({ queryKey: ['admin', 'notices'] }); client.invalidateQueries({ queryKey: ['notices'] }); };
  const custom = creatingCategory || !defaultCategories.includes(draft.category);
  // A new category is stored under its English name when there is one, so the same category is recognised later.
  const categoryName = () => creatingCategory ? (draft.labels.en.trim() || draft.labels.uz.trim() || draft.labels.ru.trim()) : draft.category;
  const save = useMutation({
    mutationFn: () => saveNotice(editing === 'new' || editing === null ? null : editing.id, {
      category: categoryName(), published: draft.published, pinned: draft.pinned,
      translations: Object.fromEntries(codes.filter(code => written(draft.texts[code])).map(code => [code, { title: draft.texts[code].title.trim(), body: draft.texts[code].body.trim() }])),
      // The two built-in categories are translated by the website itself.
      ...(custom ? { category_labels: Object.fromEntries(codes.map(code => [code, draft.labels[code].trim()]).filter(([, label]) => label)) } : {}),
    }),
    onSuccess: () => { setEditing(null); setSaved('Notice saved.'); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const remove = useMutation({
    mutationFn: (item: AdminNotice) => deleteNotice(item.id),
    onSuccess: () => { setDeleting(null); setSaved('Notice deleted.'); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const pin = useMutation({
    mutationFn: (item: AdminNotice) => pinNotice(item.id, !item.pinned),
    onSuccess: item => { setSaved(item.pinned ? 'Notice pinned.' : 'Notice unpinned.'); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const busy = save.isPending || remove.isPending;
  const open = editing !== null || deleting !== null;
  useEffect(() => {
    // A modal dialog focuses its first control (the close button); start in the title field instead.
    if (open && !dialog.current?.open) { dialog.current?.showModal(); titleInput.current?.focus(); }
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => { if (deleting) cancelDelete.current?.focus(); }, [deleting]);
  useEffect(() => { if (creatingCategory) labelInput.current?.focus(); }, [creatingCategory]);
  useEffect(() => { signOutIfExpired(list.error); }, [list.error]);
  // Categories to pick from: the built-in ones, every category already used, and the one on the notice being edited.
  const categories = distinctCategories([...defaultCategories, ...(list.data ?? []).map(item => item.category), ...(editing && editing !== 'new' ? [editing.category] : [])]);
  const knownLabels = (category: string) => (list.data ?? []).find(item => item.category === category)?.category_labels ?? {};
  // A category's name for the admin: its name in the admin's language, another language, or the built-in translation.
  const categoryLabel = (category: string, labels: Partial<Record<Locale, string>>) => labels[locale] ?? codes.map(code => labels[code]).find(Boolean) ?? t(category);

  function compose(item: AdminNotice | 'new') {
    save.reset(); setErrors({}); setSaved(null); setCreatingCategory(false);
    if (item === 'new') { setDraft(blank()); setLanguage(locale); }
    else {
      setDraft({ category: item.category, labels: each(code => item.category_labels[code] ?? ''), texts: each(code => item.translations[code] ?? { title: '', body: '' }), published: item.published, pinned: item.pinned });
      // Open on the admin's own language when the notice has it, otherwise on a language it is written in.
      setLanguage(item.translations[locale] ? locale : codes.find(code => item.translations[code]) ?? locale);
    }
    setEditing(item);
  }
  function chooseCategory(category: string) {
    setCreatingCategory(false); setErrors({ ...errors, category: undefined });
    setDraft({ ...draft, category, labels: each(code => knownLabels(category)[code] ?? '') });
  }
  function setText(key: keyof Text, value: string) { setDraft({ ...draft, texts: { ...draft.texts, [language]: { ...draft.texts[language], [key]: value } } }); setErrors({ ...errors, text: undefined }); }
  function confirmDelete(item: AdminNotice) { remove.reset(); setSaved(null); setDeleting(item); }
  function close() { if (!busy) { setEditing(null); setDeleting(null); } }
  function submit(event: FormEvent) {
    event.preventDefault();
    const problems: Errors = {};
    if (categoryName().length < 2) problems.category = creatingCategory ? 'Please enter the category name in at least one language.' : 'Please choose or enter a category.';
    // A language is either written completely or left empty; a half-written one would be silently dropped.
    const unfinished = codes.find(code => started(draft.texts[code]) && !written(draft.texts[code]));
    if (unfinished) { problems.text = 'Please complete both the title and the text in this language, or clear both.'; setLanguage(unfinished); }
    else if (!codes.some(code => written(draft.texts[code]))) problems.text = 'Please write the notice in at least one language.';
    setErrors(problems);
    if (!problems.category && !problems.text) save.mutate();
  }
  function date(value: string) { return new Intl.DateTimeFormat(locale === 'uz' ? 'uz-UZ' : locale === 'ru' ? 'ru-RU' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  function errorMessage(error: Error | null) { return t(error instanceof AdminError ? error.message : 'The local admin service is unavailable. Please check that the backend is running.'); }
  const text = draft.texts[language];

  return <>
    <div className="admin-title"><div><p className="admin-eyebrow">{t('Admissions admin')}</p><h1>{t('Notices')}</h1><p>{t('Post news and admission guides for families.')}</p></div><div className="admin-title-actions"><a className="admin-secondary" href="/#notices">{t('View on website')} ↗</a><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('New notice')} +</button></div></div>
    {saved && <p className="admin-success" role="status">{t(saved)}</p>}
    {pin.isError && <p className="admin-error" role="alert">{errorMessage(pin.error)}</p>}
    <section className="admin-inbox" aria-label={t('Notices')}>
      {list.isPending ? <div className="admin-empty" role="status">{t('Loading…')}</div> : list.isError ? <div className="admin-empty admin-error" role="alert"><p>{errorMessage(list.error)}</p><button className="admin-secondary" onClick={() => list.refetch()}>{t('Try again')}</button></div> : list.data.length ? <div className="admin-table-scroll"><table><thead><tr><th scope="col">{t('Title')}</th><th scope="col">{t('Category')}</th><th scope="col">{t('Status')}</th><th scope="col">{t('Date')}</th><th scope="col"><span className="sr-only">{t('Edit')}</span></th></tr></thead><tbody>{list.data.map(item => <tr key={item.id} className={item.pinned ? 'admin-pinned-row' : undefined}>
        <td><strong>{item.title}</strong><span className="admin-notice-preview">{codes.map(code => item.translations[code]?.body).find(Boolean)}</span>
          <span className="admin-languages" aria-label={t('Language of the notice')}>{languages.map(({ code, short }) => <span key={code} className={item.translations[code] ? 'on' : undefined} title={`${short}: ${t(item.translations[code] ? 'Written' : 'Not written yet')}`}>{short}</span>)}</span></td>
        <td data-label={t('Category')}><span className="admin-grade">{categoryLabel(item.category, item.category_labels)}</span></td>
        <td data-label={t('Status')}><span className={`admin-status ${item.published ? 'received' : 'new'}`}><i />{t(item.published ? 'Published' : 'Draft')}</span></td>
        <td data-label={t('Date')} className="admin-date">{date(item.published_at ?? item.updated_at)}</td>
        <td className="admin-row-actions"><button className={item.pinned ? 'admin-pin-toggle on' : 'admin-pin-toggle'} aria-pressed={item.pinned} title={t(item.pinned ? 'Unpin' : 'Pin')} disabled={pin.isPending} onClick={() => { setSaved(null); pin.mutate(item); }} aria-label={`${t(item.pinned ? 'Unpin' : 'Pin')}: ${item.title}`}><PinIcon filled={item.pinned} size={13} />{t(item.pinned ? 'Pinned' : 'Pin')}</button><button className="admin-view" onClick={() => compose(item)} aria-label={`${t('Edit')}: ${item.title}`}>{t('Edit')} ↗</button><button className="admin-delete-link" onClick={() => confirmDelete(item)} aria-label={`${t('Delete notice')}: ${item.title}`}>{t('Delete notice')}</button></td>
      </tr>)}</tbody></table></div> : <div className="admin-empty"><span aria-hidden="true">✎</span><h2>{t('No notices yet.')}</h2><p>{t('Post your first notice to show it on the website.')}</p><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('New notice')} +</button></div>}
    </section>
    <p className="admin-workflow-note">{t('Parents see each notice in their own language. Where a translation is missing, another language is shown.')}</p>
    {/* Only the delete confirmation closes on a backdrop click, so a slip cannot discard typed text. */}
    <dialog ref={dialog} className={editing ? 'admin-dialog admin-dialog-wide' : 'admin-dialog'} aria-labelledby="notice-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (deleting && event.target === event.currentTarget) close(); }}>
      {deleting ? <div className="admin-dialog-content">
        <p className="admin-eyebrow">{t('Delete notice')}</p><h2 id="notice-dialog-title">{t('Delete this notice?')}</h2>
        <div className="admin-delete-target"><strong>{deleting.title}</strong><span>{categoryLabel(deleting.category, deleting.category_labels)}</span></div>
        <p className="admin-delete-warning">{t('This permanently removes the notice from the website. This cannot be undone.')}</p>
        {remove.isError && <p className="admin-error" role="alert">{errorMessage(remove.error)}</p>}
        <div className="admin-confirm-actions"><button ref={cancelDelete} className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-danger" type="button" disabled={busy} onClick={() => remove.mutate(deleting)}>{t(remove.isPending ? 'Deleting…' : 'Delete permanently')}</button></div>
      </div> : editing && <form className="admin-dialog-content admin-notice-form" onSubmit={submit} noValidate>
        <div className="admin-dialog-top"><p className="admin-eyebrow">{t('Notices')}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
        <h2 id="notice-dialog-title">{t(editing === 'new' ? 'New notice' : 'Edit notice')}</h2>
        <fieldset className="admin-category"><legend>{t('Category')}</legend>
          <div className="admin-chips">{categories.map(name => <button key={name} type="button" className="admin-chip" aria-pressed={!creatingCategory && draft.category === name} onClick={() => chooseCategory(name)}>{categoryLabel(name, knownLabels(name))}</button>)}<button type="button" className="admin-chip admin-chip-new" aria-pressed={creatingCategory} onClick={() => { if (!creatingCategory) { setCreatingCategory(true); setDraft({ ...draft, labels: each(() => '') }); } }}>+ {t('New category')}</button></div>
          {custom && <div className="admin-category-names"><p id="notice-category-hint">{t('Category name in each language')}<small>{t('Enter the name in at least one language. Missing languages show another one.')}</small></p>
            <div className="admin-form-row">{languages.map(({ code, label }, index) => <label key={code} htmlFor={`notice-category-${code}`}>{label}<input id={`notice-category-${code}`} ref={index === 0 ? labelInput : undefined} lang={code} value={draft.labels[code]} maxLength={40} aria-describedby="notice-category-hint" aria-invalid={!!errors.category} onChange={event => { setDraft({ ...draft, labels: { ...draft.labels, [code]: event.target.value } }); setErrors({ ...errors, category: undefined }); }} /></label>)}</div></div>}
          {errors.category && <span className="admin-field-error" role="alert">{t(errors.category)}</span>}
        </fieldset>
        <fieldset className="admin-translations"><legend>{t('Language of the notice')}</legend>
          <div className="admin-language-tabs" role="tablist" aria-label={t('Language of the notice')}>{languages.map(({ code, label }) => <button key={code} type="button" role="tab" id={`notice-tab-${code}`} aria-selected={language === code} aria-controls="notice-text" className={written(draft.texts[code]) ? 'written' : undefined} onClick={() => { setLanguage(code); setErrors({ ...errors, text: undefined }); }}><i aria-hidden="true" />{label}<span className="sr-only"> — {t(written(draft.texts[code]) ? 'Written' : 'Not written yet')}</span></button>)}</div>
          <div id="notice-text" role="tabpanel" aria-labelledby={`notice-tab-${language}`}>
            <label htmlFor="notice-title">{t('Title')}<input id="notice-title" ref={titleInput} lang={language} value={text.title} maxLength={160} onChange={event => setText('title', event.target.value)} aria-invalid={!!errors.text} aria-describedby={errors.text ? 'notice-text-error' : 'notice-text-hint'} /></label>
            <label htmlFor="notice-body">{t('Text')}<textarea id="notice-body" rows={7} lang={language} value={text.body} maxLength={5000} onChange={event => setText('body', event.target.value)} aria-invalid={!!errors.text} aria-describedby={errors.text ? 'notice-text-error' : 'notice-text-hint'} /></label>
            {errors.text ? <span id="notice-text-error" className="admin-field-error" role="alert">{t(errors.text)}</span> : <small id="notice-text-hint" className="admin-category-hint">{t('Write the notice in at least one language. Parents see it in their own language; if that version is missing, another language is shown.')}</small>}
          </div>
        </fieldset>
        <label className="admin-check" htmlFor="notice-published"><input id="notice-published" type="checkbox" checked={draft.published} onChange={event => setDraft({ ...draft, published: event.target.checked })} aria-describedby="notice-published-hint" /><span>{t('Show on the website')}<small id="notice-published-hint">{t('Unticked notices are kept as drafts that only admins can see.')}</small></span></label>
        <label className="admin-check" htmlFor="notice-pinned"><input id="notice-pinned" type="checkbox" checked={draft.pinned} onChange={event => setDraft({ ...draft, pinned: event.target.checked })} aria-describedby="notice-pinned-hint" /><span>{t('Pin to the top of the notices')}<small id="notice-pinned-hint">{t('Pinned notices stay first on the website and are highlighted.')}</small></span></label>
        {save.isError && <p className="admin-error" role="alert">{errorMessage(save.error)}</p>}
        <div className="admin-confirm-actions"><button className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-primary" type="submit" disabled={busy}>{t(save.isPending ? 'Saving…' : 'Save notice')}</button></div>
      </form>}
    </dialog>
  </>;
}
