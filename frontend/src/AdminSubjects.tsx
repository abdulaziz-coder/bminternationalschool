import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from './i18n';
import { languages, type Locale } from './translations';
import { AdminError, adminSubjects, deleteSubject, saveSubject, subjectLabel, type AdminSubject, type SubjectDraft } from './admin-api';

const allGrades = Array.from({ length: 11 }, (_, index) => index + 1);
// One-tap choices for the usual school stages.
const presets: [string, number[]][] = [['All grades', allGrades], ['Grades 1–4', [1, 2, 3, 4]], ['Grades 5–9', [5, 6, 7, 8, 9]], ['Grades 10–11', [10, 11]]];
const blank: SubjectDraft = { names: { uz: '', en: '', ru: '' }, grades: [] };
const tidy = (text: string) => text.trim().replace(/\s+/g, ' ');

// Example names in each language, shown until the admin types.
const placeholders: Record<Locale, string> = { uz: 'Matematika', en: 'Mathematics', ru: 'Математика' };

/** Consecutive grades as ranges: [1, 2, 3, 4, 7, 9, 10] becomes ["1–4", "7", "9–10"]. */
export function gradeRanges(grades: number[]) {
  const ranges: string[] = [];
  for (let index = 0; index < grades.length; index++) {
    const first = grades[index];
    while (grades[index + 1] === grades[index] + 1) index++;
    ranges.push(first === grades[index] ? String(first) : `${first}–${grades[index]}`);
  }
  return ranges;
}

/** The admin tab for school subjects: add, rename, and remove subjects, and choose which grades take each one. */
export default function AdminSubjects({ onSignedOut }: { onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [grade, setGrade] = useState('');
  // At most one of these is set; together they decide what the dialog shows.
  const [editing, setEditing] = useState<AdminSubject | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminSubject | null>(null);
  const [draft, setDraft] = useState<SubjectDraft>(blank);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const list = useQuery({ queryKey: ['admin', 'subjects'], queryFn: adminSubjects, retry: false, staleTime: 0 });
  const signOutIfExpired = (error: Error | null) => { if (error instanceof AdminError && error.status === 401) onSignedOut(); };
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'subjects'] });
  const save = useMutation({
    mutationFn: () => saveSubject(editing === 'new' || editing === null ? null : editing.id, { names: { uz: tidy(draft.names.uz), en: tidy(draft.names.en), ru: tidy(draft.names.ru) }, grades: draft.grades }),
    onSuccess: () => { setEditing(null); setSaved(t('Subject saved.')); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const remove = useMutation({
    mutationFn: (item: AdminSubject) => deleteSubject(item.id),
    onSuccess: () => { setDeleting(null); setSaved(t('Subject removed.')); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const busy = save.isPending || remove.isPending;
  const open = editing !== null || deleting !== null;
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => { if (editing) nameInput.current?.focus(); }, [editing]);
  useEffect(() => { if (deleting) cancelDelete.current?.focus(); }, [deleting]);
  useEffect(() => { signOutIfExpired(list.error); }, [list.error]);

  function compose(item: AdminSubject | 'new') {
    save.reset(); setNameError(null); setSaved(null);
    setDraft(item === 'new' ? blank : { names: { uz: item.names.uz ?? '', en: item.names.en ?? '', ru: item.names.ru ?? '' }, grades: item.grades });
    setEditing(item);
  }
  function close() { if (!busy) { setEditing(null); setDeleting(null); } }
  function toggle(value: number) {
    setDraft({ ...draft, grades: draft.grades.includes(value) ? draft.grades.filter(item => item !== value) : [...draft.grades, value].sort((a, b) => a - b) });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const names = Object.values(draft.names).map(tidy).filter(Boolean);
    // No name may already belong to another subject, in any language.
    const others = (list.data ?? []).filter(item => editing === 'new' || editing?.id !== item.id).flatMap(item => [item.name, ...Object.values(item.names)].map(name => (name ?? '').toLowerCase()));
    const problem = names.length === 0 ? 'Please enter the subject’s name in at least one language.' : names.some(name => name.length < 2) ? 'Each name needs at least 2 characters.' : names.some(name => others.includes(name.toLowerCase())) ? 'A subject with this name already exists.' : null;
    setNameError(problem);
    if (!problem) save.mutate();
  }
  function gradeName(value: number) { return locale === 'uz' ? `${value}-sinf` : locale === 'ru' ? `${value} класс` : `Grade ${value}`; }
  function errorMessage(error: Error | null) { return t(error instanceof AdminError ? error.message : 'The local admin service is unavailable. Please check that the backend is running.'); }
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);
  const query = search.trim().toLowerCase();
  const label = (item: AdminSubject) => subjectLabel(item, locale);
  // Searching finds a subject by its name in any language.
  const shown = (list.data ?? []).filter(item => (!query || [item.name, ...Object.values(item.names)].some(name => (name ?? '').toLowerCase().includes(query))) && (!grade || item.grades.includes(Number(grade))))
    .sort((a, b) => label(a).localeCompare(label(b), locale));
  const missing = (item: AdminSubject) => languages.filter(({ code }) => !item.names[code]);
  const filtered = !!(query || grade);
  const total = list.data?.length ?? 0;

  return <>
    <div className="admin-title"><div><p className="admin-eyebrow">{t('Admissions admin')}</p><h1>{t('Subjects')}</h1><p>{t('Keep the list of subjects and choose which grades take each one.')}</p></div><div className="admin-title-actions"><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('Add subject')} +</button></div></div>
    {saved && <p className="admin-success" role="status">{saved}</p>}
    <section className="admin-inbox" aria-label={t('Subjects')}>
      <div className="admin-toolbar"><label className="admin-search" htmlFor="subject-search"><span className="sr-only">{t('Search subjects')}</span><span aria-hidden="true">⌕</span><input id="subject-search" type="search" placeholder={t('Search by subject name')} value={search} maxLength={80} onChange={event => setSearch(event.target.value)} /></label>
        <label className="admin-filter"><span className="sr-only">{t('Grade')}</span><select aria-label={t('Grade')} value={grade} onChange={event => setGrade(event.target.value)}><option value="">{t('All grades')}</option>{allGrades.map(value => <option key={value} value={value}>{gradeName(value)}</option>)}</select></label>
      </div>
      {list.isPending ? <div className="admin-empty" role="status">{t('Loading…')}</div> : list.isError ? <div className="admin-empty admin-error" role="alert"><p>{errorMessage(list.error)}</p><button className="admin-secondary" onClick={() => list.refetch()}>{t('Try again')}</button></div> : shown.length ? <div className="admin-table-scroll"><table><thead><tr><th scope="col">{t('Subject')}</th><th scope="col">{t('Grades')}</th><th scope="col">{t('Teachers')}</th><th scope="col"><span className="sr-only">{t('Edit')}</span></th></tr></thead><tbody>{shown.map(item => <tr key={item.id}>
        <td><div className="admin-person"><span className="admin-avatar" aria-hidden="true">{label(item).trim().charAt(0).toUpperCase()}</span><span><strong>{label(item)}</strong><span className="admin-languages" aria-label={t('Subject name')}>{languages.map(({ code, short }) => <span key={code} className={item.names[code] ? 'on' : undefined} title={`${short}: ${item.names[code] ?? t('Not written yet')}`}>{short}</span>)}</span></span></div></td>
        <td data-label={t('Grades')}>{item.grades.length === 0 ? <span className="admin-grades-none">{t('No grades chosen yet')}</span> : <span className="admin-grade-list" aria-label={`${t('Grades')}: ${item.grades.join(', ')}`}>{item.grades.length === 11 ? <span className="all">{t('All grades')}</span> : gradeRanges(item.grades).map(range => <span key={range}>{range}</span>)}</span>}</td>
        <td data-label={t('Teachers')}><span className={item.teachers ? 'admin-class' : 'admin-email'}>{item.teachers}</span></td>
        <td className="admin-row-actions"><button className="admin-view" onClick={() => compose(item)} aria-label={`${t('Edit')}: ${label(item)}`}>{t('Edit')} ↗</button><button className="admin-delete-link" onClick={() => { remove.reset(); setSaved(null); setDeleting(item); }} aria-label={`${t('Remove')}: ${label(item)}`}>{t('Remove')}</button></td>
      </tr>)}</tbody></table></div> : <div className="admin-empty"><span aria-hidden="true">{filtered ? '↙' : '✎'}</span><h2>{t(filtered ? 'No matching subjects.' : 'No subjects yet.')}</h2><p>{t(filtered ? 'Try another search or clear your filters.' : 'Add the subjects your school teaches, then choose their grades.')}</p>{filtered ? <button className="admin-secondary" onClick={() => { setSearch(''); setGrade(''); }}>{t('Clear filters')}</button> : <button type="button" className="admin-primary" onClick={() => compose('new')}>{t('Add subject')} +</button>}</div>}
      <div className="admin-pagination"><span>{filtered ? `${shown.length} / ${total}` : total} {t('results')}</span></div>
    </section>
    {/* Typed text is only discarded by an explicit Cancel or Close, never by a backdrop click. */}
    <dialog ref={dialog} className={deleting ? 'admin-dialog' : 'admin-dialog admin-dialog-wide'} aria-labelledby="subject-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (deleting && event.target === event.currentTarget) close(); }}>
      {deleting ? <div className="admin-dialog-content">
        <p className="admin-eyebrow">{t('Remove subject')}</p><h2 id="subject-dialog-title">{t('Remove this subject?')}</h2>
        <div className="admin-delete-target"><strong>{label(deleting)}</strong></div>
        {deleting.teachers > 0 ? <p className="admin-delete-warning">{t('This subject cannot be removed while teachers teach it. Give those teachers another subject in the Teachers tab first.')} ({t('Teachers')}: {deleting.teachers})</p> : <p className="admin-delete-warning">{t('This permanently removes the subject and its grades from the local database. This cannot be undone.')}</p>}
        {remove.isError && <p className="admin-error" role="alert">{errorMessage(remove.error)}</p>}
        <div className="admin-confirm-actions"><button ref={cancelDelete} className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-danger" type="button" disabled={busy || deleting.teachers > 0} onClick={() => remove.mutate(deleting)}>{t(remove.isPending ? 'Deleting…' : 'Delete permanently')}</button></div>
      </div> : editing && <form className="admin-dialog-content admin-notice-form" onSubmit={submit} noValidate>
        <div className="admin-dialog-top"><p className="admin-eyebrow">{t('Subjects')}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
        <h2 id="subject-dialog-title">{t(editing === 'new' ? 'Add subject' : 'Edit subject')}</h2>
        {editing !== 'new' && editing.teachers > 0 && <p className="admin-form-note">{t('Renaming this subject also renames it for its teachers.')} ({t('Teachers')}: {editing.teachers})</p>}
        <fieldset className="admin-category admin-subject-names" aria-describedby={nameError ? 'subject-name-error' : 'subject-name-hint'}>
          <legend>{t('Subject name in each language')}</legend>
          <div className="admin-form-row">{languages.map(({ code, label: language }, index) => <label key={code} htmlFor={`subject-name-${code}`} lang={code}>{language}<input id={`subject-name-${code}`} ref={index === 0 ? nameInput : undefined} value={draft.names[code]} maxLength={80} placeholder={placeholders[code]} autoComplete="off" onChange={event => { setDraft({ ...draft, names: { ...draft.names, [code]: event.target.value } }); setNameError(null); }} aria-invalid={!!nameError} /></label>)}</div>
          {nameError ? <span id="subject-name-error" className="admin-field-error" role="alert">{t(nameError)}</span> : <span id="subject-name-hint" className="admin-category-hint">{t('Enter the name in at least one language. Where a name is missing, another language is shown.')}</span>}
        </fieldset>
        <fieldset className="admin-category admin-grade-picker">
          <legend>{t('Grades that take this subject')}</legend>
          <div className="admin-chips admin-grade-chips">{allGrades.map(value => <button key={value} type="button" className="admin-chip" aria-pressed={draft.grades.includes(value)} aria-label={gradeName(value)} onClick={() => toggle(value)}>{value}</button>)}</div>
          <div className="admin-grade-presets"><span>{t('Quick choice')}:</span>{presets.map(([label, grades]) => <button key={label} type="button" className="admin-view" aria-pressed={same(draft.grades, grades)} onClick={() => setDraft({ ...draft, grades })}>{t(label)}</button>)}<button type="button" className="admin-view" disabled={draft.grades.length === 0} onClick={() => setDraft({ ...draft, grades: [] })}>{t('Clear')}</button></div>
          <span className="admin-category-hint" role="status">{draft.grades.length === 0 ? t('No grades chosen yet. You can save the subject now and choose its grades later.') : `${t('Chosen')}: ${draft.grades.length === 11 ? t('All grades') : gradeRanges(draft.grades).join(', ')}`}</span>
        </fieldset>
        {save.isError && <p className="admin-error" role="alert">{errorMessage(save.error)}</p>}
        <div className="admin-confirm-actions"><button className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-primary" type="submit" disabled={busy}>{t(save.isPending ? 'Saving…' : 'Save subject')}</button></div>
      </form>}
    </dialog>
  </>;
}
