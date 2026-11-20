import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from './i18n';
import { AdminError, adminSubjects, subjectLabel, adminTeachers, createTeacher, deleteTeacher, importTeachers, resetTeacherPassword, teacherTemplateUrl, updateTeacher, type AdminTeacher, type TeacherDraft, type TeacherImportReport } from './admin-api';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const blank: TeacherDraft = { full_name: '', subject: '', phone: '' };
const problemReasons = { missing_name: 'The name is missing', missing_subject: 'The subject is missing', unknown_subject: 'The subject is not in the subject list', bad_phone: 'The phone number is not valid', bad_value: 'A value is too long' };
type Errors = { full_name?: string; subject?: string; phone?: string };
/** Sign-in details that were just generated. They exist only in this component's memory until the admin closes the dialog. */
type Issued = { full_name: string; subject: string; login: string; password: string };

/** The admin tab for the staff list: add, edit, and remove teachers, import them from Excel, and issue their sign-in details. */
export default function AdminTeachers({ onSignedOut }: { onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // At most one of these is set; together they decide what the dialog shows.
  const [editing, setEditing] = useState<AdminTeacher | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminTeacher | null>(null);
  const [resetting, setResetting] = useState<AdminTeacher | null>(null);
  const [importing, setImporting] = useState(false);
  const [issued, setIssued] = useState<Issued[] | null>(null);
  const [draft, setDraft] = useState<TeacherDraft>(blank);
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const safeButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['admin', 'teachers', q, page], queryFn: () => adminTeachers({ q, page }), retry: false, staleTime: 0 });
  // A teacher's subject is chosen from the subjects the admin has created.
  const subjects = useQuery({ queryKey: ['admin', 'subjects'], queryFn: adminSubjects, retry: false, staleTime: 0 });
  const signOutIfExpired = (error: Error | null) => { if (error instanceof AdminError && error.status === 401) onSignedOut(); };
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'teachers'] });
  const tidy = () => ({ full_name: draft.full_name.trim(), subject: draft.subject.trim(), phone: draft.phone.trim() });
  const create = useMutation({
    mutationFn: () => createTeacher(tidy()),
    onSuccess: ({ teacher, password }) => { setEditing(null); setIssued([{ ...teacher, password }]); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const update = useMutation({
    mutationFn: (item: AdminTeacher) => updateTeacher(item.id, tidy()),
    onSuccess: () => { setEditing(null); setSaved(t('Teacher saved.')); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const reset = useMutation({
    mutationFn: (item: AdminTeacher) => resetTeacherPassword(item.id),
    onSuccess: ({ teacher, password }) => { setResetting(null); setIssued([{ ...teacher, password }]); }, onError: signOutIfExpired, retry: false,
  });
  const remove = useMutation({
    mutationFn: (item: AdminTeacher) => deleteTeacher(item.id),
    onSuccess: () => { setDeleting(null); setSaved(t('Teacher removed.')); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  // Step one reads the workbook and reports what it contains; step two saves it and returns the new sign-in details.
  const preview = useMutation({ mutationFn: (chosen: File) => importTeachers(chosen, false), onError: signOutIfExpired, retry: false });
  const commit = useMutation({
    mutationFn: (chosen: File) => importTeachers(chosen, true),
    onSuccess: report => { closeImport(); setIssued(report.credentials); setSaved(`${report.added} ${t('teachers added.')}`); setPage(1); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const saving = create.isPending || update.isPending;
  const busy = saving || remove.isPending || reset.isPending || commit.isPending;
  const open = editing !== null || deleting !== null || resetting !== null || importing || issued !== null;
  useEffect(() => { const timer = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  // A modal dialog focuses its first control; start in the name field, or on the safe choice of a confirmation.
  useEffect(() => { if (editing) nameInput.current?.focus(); }, [editing]);
  useEffect(() => { if (deleting || resetting || issued) safeButton.current?.focus(); }, [deleting, resetting, issued]);
  useEffect(() => { signOutIfExpired(list.error); }, [list.error]);
  useEffect(() => { if (list.data && page > Math.max(1, Math.ceil(list.data.total / list.data.page_size))) setPage(Math.max(1, Math.ceil(list.data.total / list.data.page_size))); }, [list.data, page]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1800); return () => clearTimeout(timer); }, [copied]);

  function compose(item: AdminTeacher | 'new') {
    create.reset(); update.reset(); setErrors({}); setSaved(null);
    setDraft(item === 'new' ? blank : { full_name: item.full_name, subject: item.subject, phone: item.phone ?? '' });
    setEditing(item);
  }
  function openImport() { preview.reset(); commit.reset(); setFile(null); setFileProblem(null); setSaved(null); setImporting(true); }
  function closeImport() { setImporting(false); setFile(null); setDragging(false); }
  // Generated passwords are never closed by accident: that dialog only closes from its own button.
  function close() { if (!busy && !issued) { setEditing(null); setDeleting(null); setResetting(null); closeImport(); } }
  function chooseFile(chosen: File | undefined) {
    if (!chosen) return;
    commit.reset(); preview.reset(); setFile(chosen);
    // Check the limits here first, so an oversized or wrong file is refused straight away without being uploaded.
    const problem = !chosen.name.toLowerCase().endsWith('.xlsx') ? 'This file could not be read. Please upload an Excel .xlsx file.' : chosen.size > MAX_FILE_BYTES ? 'The file is larger than 5 MB.' : null;
    setFileProblem(problem);
    if (!problem) preview.mutate(chosen);
  }
  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }
  function submit(event: FormEvent) {
    event.preventDefault();
    const problems: Errors = {};
    if (draft.full_name.trim().length < 2) problems.full_name = 'Please enter the teacher’s full name.';
    if (!draft.subject) problems.subject = 'Please choose the subject the teacher teaches.';
    const digits = draft.phone.replace(/\D/g, '');
    if (draft.phone.trim() && (!/^\+?[0-9 ().-]+$/.test(draft.phone.trim()) || digits.length < 7 || digits.length > 15)) problems.phone = 'Please enter a valid phone number with 7 to 15 digits.';
    setErrors(problems);
    if (Object.values(problems).some(Boolean)) return;
    if (editing === 'new') create.mutate(); else if (editing) update.mutate(editing);
  }
  function set(key: keyof TeacherDraft, value: string) { setDraft({ ...draft, [key]: value }); setErrors({ ...errors, [key]: undefined }); }
  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setCopied(label); } catch { /* The text stays on screen to copy by hand. */ }
  }
  function download(items: Issued[]) {
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [[t('Full name'), t('Subject'), t('Login'), t('Password')], ...items.map(item => [item.full_name, item.subject, item.login, item.password])];
    // The byte-order mark makes Excel read the names as UTF-8.
    const url = URL.createObjectURL(new Blob(['﻿' + rows.map(row => row.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'teachers-sign-in.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function errorMessage(error: Error | null) { return t(error instanceof AdminError ? error.message : 'The local admin service is unavailable. Please check that the backend is running.'); }
  const report: TeacherImportReport | undefined = preview.data;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  const saveError = create.error ?? update.error;
  const confirming = deleting ?? resetting;
  const subjectNames = (subjects.data ?? []).map(item => item.name);
  // A teacher's record holds the subject's main name; show it in the admin's language when it is in the list.
  const subjectName = (name: string) => { const found = subjects.data?.find(item => item.name === name); return found ? subjectLabel(found, locale) : name; };
  const subjectOptions = (subjects.data ?? []).map(item => ({ value: item.name, label: subjectLabel(item, locale) })).sort((a, b) => a.label.localeCompare(b.label, locale));
  // A teacher added before the subject list existed keeps their subject until the admin picks another.
  const legacySubject = editing && editing !== 'new' && !subjectNames.includes(editing.subject) ? editing.subject : null;
  const noSubjects = subjects.isSuccess && subjectNames.length === 0;

  return <>
    <div className="admin-title"><div><p className="admin-eyebrow">{t('Admissions admin')}</p><h1>{t('Teachers')}</h1><p>{t('Keep the staff list and issue each teacher a login and password for the teacher pages.')}</p></div><div className="admin-title-actions"><button type="button" className="admin-secondary" onClick={openImport}><ExcelIcon />{t('Import from Excel')}</button><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('Add teacher')} +</button></div></div>
    {saved && <p className="admin-success" role="status">{saved}</p>}
    <section className="admin-inbox" aria-label={t('Teachers')}>
      <div className="admin-toolbar"><label className="admin-search" htmlFor="teacher-search"><span className="sr-only">{t('Search teachers')}</span><span aria-hidden="true">⌕</span><input id="teacher-search" type="search" placeholder={t('Search by teacher, subject, phone, or login')} value={search} maxLength={200} onChange={event => setSearch(event.target.value)} /></label></div>
      {list.isPending ? <div className="admin-empty" role="status">{t('Loading…')}</div> : list.isError ? <div className="admin-empty admin-error" role="alert"><p>{errorMessage(list.error)}</p><button className="admin-secondary" onClick={() => list.refetch()}>{t('Try again')}</button></div> : list.data.items.length ? <div className="admin-table-scroll"><table><thead><tr><th scope="col">{t('Teacher')}</th><th scope="col">{t('Subject')}</th><th scope="col">{t('Phone')}</th><th scope="col">{t('Login')}</th><th scope="col"><span className="sr-only">{t('Edit')}</span></th></tr></thead><tbody>{list.data.items.map(item => <tr key={item.id}>
        <td><div className="admin-person"><span className="admin-avatar" aria-hidden="true">{item.full_name.trim().charAt(0).toUpperCase()}</span><strong>{item.full_name}</strong></div></td>
        <td data-label={t('Subject')}><span className="admin-class">{subjectName(item.subject)}</span></td>
        <td data-label={t('Phone')}><span className="admin-email">{item.phone || t('Not recorded')}</span></td>
        <td data-label={t('Login')}><code className="admin-code">{item.login}</code></td>
        <td className="admin-row-actions"><button className="admin-view" onClick={() => compose(item)} aria-label={`${t('Edit')}: ${item.full_name}`}>{t('Edit')} ↗</button><button className="admin-view" onClick={() => { reset.reset(); setSaved(null); setResetting(item); }} aria-label={`${t('Generate password')}: ${item.full_name}`}>{t('Generate password')}</button><button className="admin-delete-link" onClick={() => { remove.reset(); setSaved(null); setDeleting(item); }} aria-label={`${t('Remove')}: ${item.full_name}`}>{t('Remove')}</button></td>
      </tr>)}</tbody></table></div> : <div className="admin-empty"><span aria-hidden="true">{q ? '↙' : '✎'}</span><h2>{t(q ? 'No matching teachers.' : 'No teachers yet.')}</h2><p>{t(q ? 'Try another search.' : 'Add teachers one by one or import your Excel list.')}</p>{q ? <button className="admin-secondary" onClick={() => { setSearch(''); setQ(''); setPage(1); }}>{t('Clear search')}</button> : <div className="admin-empty-actions"><button type="button" className="admin-secondary" onClick={openImport}><ExcelIcon />{t('Import from Excel')}</button><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('Add teacher')} +</button></div>}</div>}
      <div className="admin-pagination"><span>{list.data?.total ?? 0} {t('results')} · {t('Page')} {page} {t('of')} {pages}</span><div><button className="admin-secondary" disabled={page === 1 || list.isFetching} onClick={() => setPage(page - 1)}>← {t('Previous')}</button><button className="admin-secondary" disabled={page >= pages || list.isFetching} onClick={() => setPage(page + 1)}>{t('Next')} →</button></div></div>
    </section>
    <dialog ref={dialog} className={confirming ? 'admin-dialog' : 'admin-dialog admin-dialog-wide'} aria-labelledby="teacher-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (confirming && event.target === event.currentTarget) close(); }}>
      {issued ? <div className="admin-dialog-content">
        <p className="admin-eyebrow">{t('Teachers')}</p><h2 id="teacher-dialog-title">{t('Sign-in details')}</h2>
        <p className="admin-limit-note" role="note"><InfoIcon /><span><strong>{t('Save these sign-in details now.')}</strong>{t('Each password keeps working until you generate a new one. For security it is displayed only this once, so copy or download it and pass it to the teacher.')}</span></p>
        {issued.length === 1 ? <div className="admin-credential">
          <strong>{issued[0].full_name}</strong><span>{issued[0].subject}</span>
          <dl>{([['Login', issued[0].login], ['Password', issued[0].password]] as const).map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd><code>{value}</code><button type="button" className="admin-view" onClick={() => copy(value, label)}>{t(copied === label ? 'Copied' : 'Copy')}</button></dd></div>)}</dl>
        </div> : <div className="admin-import-list admin-credential-list"><ul>{issued.map(item => <li key={item.login}><span>{item.full_name}<small>{item.subject}</small></span><span><code>{item.login}</code><code>{item.password}</code></span></li>)}</ul></div>}
        <div className="admin-confirm-actions">{issued.length > 1 && <button className="admin-secondary" type="button" onClick={() => copy(issued.map(item => `${item.full_name} — ${item.login} / ${item.password}`).join('\n'), 'all')}>{t(copied === 'all' ? 'Copied' : 'Copy all')}</button>}<button className="admin-secondary" type="button" onClick={() => download(issued)}>↓ {t('Download the list')}</button><button ref={safeButton} className="admin-primary" type="button" onClick={() => setIssued(null)}>{t('I have saved them')}</button></div>
      </div> : deleting ? <div className="admin-dialog-content">
        <p className="admin-eyebrow">{t('Remove teacher')}</p><h2 id="teacher-dialog-title">{t('Remove this teacher?')}</h2>
        <div className="admin-delete-target"><strong>{deleting.full_name}</strong><span>{deleting.subject}</span></div>
        <p className="admin-delete-warning">{t('This permanently removes the teacher, their sign-in, and their lessons in the timetable from the local database. This cannot be undone.')}</p>
        {remove.isError && <p className="admin-error" role="alert">{errorMessage(remove.error)}</p>}
        <div className="admin-confirm-actions"><button ref={safeButton} className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-danger" type="button" disabled={busy} onClick={() => remove.mutate(deleting)}>{t(remove.isPending ? 'Deleting…' : 'Delete permanently')}</button></div>
      </div> : resetting ? <div className="admin-dialog-content">
        <p className="admin-eyebrow">{t('Generate password')}</p><h2 id="teacher-dialog-title">{t('Generate a new password?')}</h2>
        <div className="admin-delete-target"><strong>{resetting.full_name}</strong><span>{resetting.login}</span></div>
        <p className="admin-delete-warning">{t('The teacher’s current password stops working and is replaced by a new one. The new password then works until you generate another.')}</p>
        {reset.isError && <p className="admin-error" role="alert">{errorMessage(reset.error)}</p>}
        <div className="admin-confirm-actions"><button ref={safeButton} className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-primary" type="button" disabled={busy} onClick={() => reset.mutate(resetting)}>{t(reset.isPending ? 'Creating…' : 'Generate password')}</button></div>
      </div> : importing ? <div className="admin-dialog-content">
        <div className="admin-dialog-top"><p className="admin-eyebrow">{t('Teachers')}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
        <h2 id="teacher-dialog-title">{t('Import teachers from Excel')}</h2>
        <p className="admin-limit-note" role="note"><InfoIcon /><span><strong>{t('File limit')}</strong>{t('Each file can be up to 5 MB and hold up to 500 teachers. Only Excel .xlsx files are accepted.')}</span></p>
        <input ref={fileInput} className="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" tabIndex={-1} aria-hidden="true" onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
        {!file ? <>
          <button type="button" className={dragging ? 'admin-dropzone dragging' : 'admin-dropzone'} onClick={() => fileInput.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}><ExcelIcon size={30} /><strong>{t('Choose an Excel file')}</strong><span>{t('or drag it here')}</span></button>
          <p className="admin-import-hint">{t('The file needs a column for the name and a column for the subject. The phone is optional. Logins and passwords are generated for you.')} {t('Each subject must already be in the Subjects tab.')} {t('The first sheet is read.')}</p>
          <a className="admin-template-link" href={teacherTemplateUrl} download>↓ {t('Download a template')}</a>
        </> : <>
          <div className="admin-file"><ExcelIcon /><span>{file.name}</span><button type="button" className="admin-view" disabled={busy || preview.isPending} onClick={() => fileInput.current?.click()}>{t('Choose another file')}</button></div>
          {fileProblem ? <p className="admin-error" role="alert">{t(fileProblem)}</p> : preview.isPending ? <p className="admin-import-status" role="status">{t('Reading the file…')}</p> : preview.isError ? <p className="admin-error" role="alert">{errorMessage(preview.error)}</p> : report && <>
            <div className="admin-import-summary"><div className="good"><strong>{report.added}</strong><span>{t('Will be added')}</span></div><div><strong>{report.duplicates}</strong><span>{t('Already in the list')}</span></div><div className={report.problem_count ? 'bad' : undefined}><strong>{report.problem_count}</strong><span>{t('Rows with problems')}</span></div></div>
            {report.added > 0 ? <div className="admin-import-list"><h3>{t('New teachers in this file')}</h3><ul>{report.preview.map((item, index) => <li key={index}><span>{item.full_name}</span><span>{item.subject}</span></li>)}</ul>{report.added > report.preview.length && <p>+ {report.added - report.preview.length} {t('and more')}</p>}</div> : <p className="admin-import-status">{t('Nothing new to add from this file.')}</p>}
            {report.problems.length > 0 && <div className="admin-import-list problems"><h3>{t('These rows will be skipped')}</h3><ul>{report.problems.map(problem => <li key={problem.row}><span>{t('Row')} {problem.row}{problem.name ? ` · ${problem.name}` : ''}</span><span>{t(problemReasons[problem.reason])}</span></li>)}</ul>{report.problem_count > report.problems.length && <p>+ {report.problem_count - report.problems.length} {t('and more')}</p>}</div>}
          </>}
          {commit.isError && <p className="admin-error" role="alert">{errorMessage(commit.error)}</p>}
        </>}
        <div className="admin-confirm-actions"><button className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button>{file && <button className="admin-primary" type="button" disabled={busy || !report || report.added === 0 || preview.isPending} onClick={() => commit.mutate(file)}>{commit.isPending ? t('Adding…') : `${t('Add teachers')}${report?.added ? ` (${report.added})` : ''}`}</button>}</div>
      </div> : editing && <form className="admin-dialog-content admin-notice-form" onSubmit={submit} noValidate>
        <div className="admin-dialog-top"><p className="admin-eyebrow">{t('Teachers')}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
        <h2 id="teacher-dialog-title">{t(editing === 'new' ? 'Add teacher' : 'Edit teacher')}</h2>
        <label htmlFor="teacher-name">{t('Full name')}<input id="teacher-name" ref={nameInput} value={draft.full_name} maxLength={120} autoComplete="off" onChange={event => set('full_name', event.target.value)} aria-invalid={!!errors.full_name} aria-describedby={errors.full_name ? 'teacher-name-error' : undefined} required />{errors.full_name && <span id="teacher-name-error" className="admin-field-error">{t(errors.full_name)}</span>}</label>
        <div className="admin-form-row two">
          <label htmlFor="teacher-subject">{t('Subject taught')}<select id="teacher-subject" value={draft.subject} disabled={subjects.isPending} onChange={event => set('subject', event.target.value)} aria-invalid={!!errors.subject} aria-describedby={errors.subject ? 'teacher-subject-error' : noSubjects ? 'teacher-subject-hint' : undefined} required><option value="" disabled hidden>{t(subjects.isPending ? 'Loading…' : 'Choose a subject')}</option>{legacySubject && <option value={legacySubject}>{legacySubject} ({t('not in the subject list')})</option>}{subjectOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{errors.subject && <span id="teacher-subject-error" className="admin-field-error">{t(errors.subject)}</span>}</label>
          <label htmlFor="teacher-phone">{t('Phone number')} <small>({t('Optional')})</small><input id="teacher-phone" type="tel" inputMode="tel" value={draft.phone} maxLength={32} placeholder="+998 90 123 45 67" autoComplete="off" onChange={event => set('phone', event.target.value)} aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'teacher-phone-error' : undefined} />{errors.phone && <span id="teacher-phone-error" className="admin-field-error">{t(errors.phone)}</span>}</label>
        </div>
        {(noSubjects || subjects.isError) && <p id="teacher-subject-hint" className="admin-form-note admin-form-warning" role="note">{t(subjects.isError ? 'The subject list could not be loaded. Please try again.' : 'There are no subjects yet. Add them in the Subjects tab first, then come back to add teachers.')} {subjects.isError ? <button type="button" className="admin-view" onClick={() => subjects.refetch()}>{t('Try again')}</button> : <a className="admin-view" href="#subjects" onClick={() => window.location.reload()}>{t('Subjects')} ↗</a>}</p>}
        <p className="admin-form-note"><KeyIcon />{editing === 'new' ? t('A login and password are generated automatically when you save. The password works until you generate a new one.') : <>{t('The login stays the same when you edit a teacher.')} <code>{editing.login}</code></>}</p>
        {saveError && <p className="admin-error" role="alert">{errorMessage(saveError)}</p>}
        <div className="admin-confirm-actions"><button className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-primary" type="submit" disabled={busy}>{t(saving ? 'Saving…' : 'Save teacher')}</button></div>
      </form>}
    </dialog>
  </>;
}

function ExcelIcon({ size = 15 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9.500 12.500l5 5M14.500 12.500l-5 5" /></svg>;
}
function InfoIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5.500M12 7.600v.100" /></svg>;
}
function KeyIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><circle cx="8" cy="15" r="4" /><path d="m11 12 8.500-8.500M16 6.500l2.500 2.500M13.500 9l2 2" /></svg>;
}
