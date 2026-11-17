import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from './i18n';
import { AdminError, adminNotices, deleteNotice, pinNotice, saveNotice, type AdminNotice, type NoticeDraft } from './admin-api';
import PinIcon from './PinIcon';
import { defaultCategories, distinctCategories } from './notice-categories';

const blank: NoticeDraft = { category: defaultCategories[0], title: '', body: '', published: true, pinned: false };

/** The admin tab for posting, editing, hiding, and deleting website notices. */
export default function AdminNotices({ onSignedOut }: { onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  // `editing` is the notice being changed, 'new' while composing one, or null when the editor is closed.
  const [editing, setEditing] = useState<AdminNotice | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminNotice | null>(null);
  const [draft, setDraft] = useState<NoticeDraft>(blank);
  const [errors, setErrors] = useState<{ category?: string; title?: string; body?: string }>({});
  // True while the admin is typing a brand-new category instead of picking an existing one.
  const [creatingCategory, setCreatingCategory] = useState(false);
  const categoryInput = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['admin', 'notices'], queryFn: adminNotices, retry: false, staleTime: 0 });
  const signOutIfExpired = (error: Error | null) => { if (error instanceof AdminError && error.status === 401) onSignedOut(); };
  const refresh = () => { client.invalidateQueries({ queryKey: ['admin', 'notices'] }); client.invalidateQueries({ queryKey: ['notices'] }); };
  const save = useMutation({
    mutationFn: () => saveNotice(editing === 'new' || editing === null ? null : editing.id, { ...draft, category: draft.category.trim(), title: draft.title.trim(), body: draft.body.trim() }),
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
  useEffect(() => { if (creatingCategory) categoryInput.current?.focus(); }, [creatingCategory]);
  // Existing categories to pick from: the defaults, every category already used, and the one on the notice being edited.
  const categories = distinctCategories([...defaultCategories, ...(list.data ?? []).map(item => item.category), ...(editing && editing !== 'new' ? [editing.category] : [])]);
  useEffect(() => { signOutIfExpired(list.error); }, [list.error]);

  function compose(item: AdminNotice | 'new') {
    save.reset(); setErrors({}); setSaved(null); setCreatingCategory(false);
    setDraft(item === 'new' ? blank : { category: item.category, title: item.title, body: item.body, published: item.published, pinned: item.pinned });
    setEditing(item);
  }
  function confirmDelete(item: AdminNotice) { remove.reset(); setSaved(null); setDeleting(item); }
  function close() { if (!busy) { setEditing(null); setDeleting(null); } }
  function submit(event: FormEvent) {
    event.preventDefault();
    const problems: typeof errors = {};
    if (draft.category.trim().length < 2) problems.category = 'Please choose or enter a category.';
    if (draft.title.trim().length < 3) problems.title = 'Please enter a title of at least 3 characters.';
    if (!draft.body.trim()) problems.body = 'Please enter the notice text.';
    setErrors(problems);
    if (!problems.category && !problems.title && !problems.body) save.mutate();
  }
  function date(value: string) { return new Intl.DateTimeFormat(locale === 'uz' ? 'uz-UZ' : locale === 'ru' ? 'ru-RU' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  function categoryName(value: string) { return t(value); }
  function errorMessage(error: Error | null) { return t(error instanceof AdminError ? error.message : 'The local admin service is unavailable. Please check that the backend is running.'); }

  return <>
    <div className="admin-title"><div><p className="admin-eyebrow">{t('Admissions admin')}</p><h1>{t('Notices')}</h1><p>{t('Post news and admission guides for families.')}</p></div><div className="admin-title-actions"><a className="admin-secondary" href="/#notices">{t('View on website')} ↗</a><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('New notice')} +</button></div></div>
    {saved && <p className="admin-success" role="status">{t(saved)}</p>}
    {pin.isError && <p className="admin-error" role="alert">{errorMessage(pin.error)}</p>}
    <section className="admin-inbox" aria-label={t('Notices')}>
      {list.isPending ? <div className="admin-empty" role="status">{t('Loading…')}</div> : list.isError ? <div className="admin-empty admin-error" role="alert"><p>{errorMessage(list.error)}</p><button className="admin-secondary" onClick={() => list.refetch()}>{t('Try again')}</button></div> : list.data.length ? <div className="admin-table-scroll"><table><thead><tr><th scope="col">{t('Title')}</th><th scope="col">{t('Category')}</th><th scope="col">{t('Status')}</th><th scope="col">{t('Date')}</th><th scope="col"><span className="sr-only">{t('Edit')}</span></th></tr></thead><tbody>{list.data.map(item => <tr key={item.id} className={item.pinned ? 'admin-pinned-row' : undefined}>
        <td><strong>{item.title}</strong><span className="admin-notice-preview">{item.body}</span></td>
        <td><span className="admin-grade">{categoryName(item.category)}</span></td>
        <td><span className={`admin-status ${item.published ? 'received' : 'new'}`}><i />{t(item.published ? 'Published' : 'Draft')}</span></td>
        <td className="admin-date">{date(item.published_at ?? item.updated_at)}</td>
        <td className="admin-row-actions"><button className={item.pinned ? 'admin-pin-toggle on' : 'admin-pin-toggle'} aria-pressed={item.pinned} title={t(item.pinned ? 'Unpin' : 'Pin')} disabled={pin.isPending} onClick={() => { setSaved(null); pin.mutate(item); }} aria-label={`: `}><PinIcon filled={item.pinned} size={13} />{t(item.pinned ? 'Pinned' : 'Pin')}</button><button className="admin-view" onClick={() => compose(item)} aria-label={`${t('Edit')}: ${item.title}`}>{t('Edit')} ↗</button><button className="admin-delete-link" onClick={() => confirmDelete(item)} aria-label={`${t('Delete notice')}: ${item.title}`}>{t('Delete notice')}</button></td>
      </tr>)}</tbody></table></div> : <div className="admin-empty"><span aria-hidden="true">✎</span><h2>{t('No notices yet.')}</h2><p>{t('Post your first notice to show it on the website.')}</p><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('New notice')} +</button></div>}
    </section>
    <p className="admin-workflow-note">{t('Notices appear on the website exactly as written, in every language.')}</p>
    {/* Only the delete confirmation closes on a backdrop click, so a slip cannot discard typed text. */}
    <dialog ref={dialog} className={editing ? 'admin-dialog admin-dialog-wide' : 'admin-dialog'} aria-labelledby="notice-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (deleting && event.target === event.currentTarget) close(); }}>
      {deleting ? <div className="admin-dialog-content">
        <p className="admin-eyebrow">{t('Delete notice')}</p><h2 id="notice-dialog-title">{t('Delete this notice?')}</h2>
        <div className="admin-delete-target"><strong>{deleting.title}</strong><span>{categoryName(deleting.category)}</span></div>
        <p className="admin-delete-warning">{t('This permanently removes the notice from the website. This cannot be undone.')}</p>
        {remove.isError && <p className="admin-error" role="alert">{errorMessage(remove.error)}</p>}
        <div className="admin-confirm-actions"><button ref={cancelDelete} className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-danger" type="button" disabled={busy} onClick={() => remove.mutate(deleting)}>{t(remove.isPending ? 'Deleting…' : 'Delete permanently')}</button></div>
      </div> : editing && <form className="admin-dialog-content admin-notice-form" onSubmit={submit} noValidate>
        <div className="admin-dialog-top"><p className="admin-eyebrow">{t('Notices')}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
        <h2 id="notice-dialog-title">{t(editing === 'new' ? 'New notice' : 'Edit notice')}</h2>
        <fieldset className="admin-category"><legend>{t('Category')}</legend>
          <div className="admin-chips">{categories.map(name => <button key={name} type="button" className="admin-chip" aria-pressed={!creatingCategory && draft.category === name} onClick={() => { setCreatingCategory(false); setDraft({ ...draft, category: name }); setErrors({ ...errors, category: undefined }); }}>{t(name)}</button>)}<button type="button" className="admin-chip admin-chip-new" aria-pressed={creatingCategory} onClick={() => { if (!creatingCategory) { setCreatingCategory(true); setDraft({ ...draft, category: '' }); } }}>+ {t('New category')}</button></div>
          {creatingCategory && <><input id="notice-category" ref={categoryInput} value={draft.category} maxLength={40} placeholder={t('Category name')} aria-label={t('Category name')} aria-invalid={!!errors.category} aria-describedby="notice-category-hint" onChange={event => { setDraft({ ...draft, category: event.target.value }); setErrors({ ...errors, category: undefined }); }} /><small id="notice-category-hint" className="admin-category-hint">{t('A new category becomes a filter on the website, shown exactly as written.')}</small></>}
          {errors.category && <span className="admin-field-error" role="alert">{t(errors.category)}</span>}
        </fieldset>
        <label htmlFor="notice-title">{t('Title')}<input id="notice-title" ref={titleInput} value={draft.title} maxLength={160} onChange={event => { setDraft({ ...draft, title: event.target.value }); setErrors({ ...errors, title: undefined }); }} aria-invalid={!!errors.title} aria-describedby={errors.title ? 'notice-title-error' : undefined} required />{errors.title && <span id="notice-title-error" className="admin-field-error">{t(errors.title)}</span>}</label>
        <label htmlFor="notice-body">{t('Text')}<textarea id="notice-body" rows={8} value={draft.body} maxLength={5000} onChange={event => { setDraft({ ...draft, body: event.target.value }); setErrors({ ...errors, body: undefined }); }} aria-invalid={!!errors.body} aria-describedby={errors.body ? 'notice-body-error' : undefined} required />{errors.body && <span id="notice-body-error" className="admin-field-error">{t(errors.body)}</span>}</label>
        <label className="admin-check" htmlFor="notice-published"><input id="notice-published" type="checkbox" checked={draft.published} onChange={event => setDraft({ ...draft, published: event.target.checked })} aria-describedby="notice-published-hint" /><span>{t('Show on the website')}<small id="notice-published-hint">{t('Unticked notices are kept as drafts that only admins can see.')}</small></span></label>
        <label className="admin-check" htmlFor="notice-pinned"><input id="notice-pinned" type="checkbox" checked={draft.pinned} onChange={event => setDraft({ ...draft, pinned: event.target.checked })} aria-describedby="notice-pinned-hint" /><span>{t('Pin to the top of the notices')}<small id="notice-pinned-hint">{t('Pinned notices stay first on the website and are highlighted.')}</small></span></label>
        {save.isError && <p className="admin-error" role="alert">{errorMessage(save.error)}</p>}
        <div className="admin-confirm-actions"><button className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-primary" type="submit" disabled={busy}>{t(save.isPending ? 'Saving…' : 'Save notice')}</button></div>
      </form>}
    </dialog>
  </>;
}
