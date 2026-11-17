import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from './i18n';
import { AdminError, adminStudents, deleteStudent, importStudents, saveStudent, studentTemplateUrl, type AdminStudent, type ImportReport, type StudentDraft } from './admin-api';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const blank: StudentDraft = { full_name: '', grade: 0, class_name: '', birth_date: null, parent_name: '', parent_phone: '' };
const problemReasons = { missing_name: 'The name is missing', bad_grade: 'The grade must be between 1 and 11', bad_date: 'The date of birth could not be read', bad_phone: 'The phone number is not valid', bad_value: 'A value is too long' };
type Errors = { full_name?: string; grade?: string; birth_date?: string; parent_phone?: string };

/** The admin tab for the student list: add, edit, and remove students, or import them from an Excel workbook. */
export default function AdminStudents({ onSignedOut }: { onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [grade, setGrade] = useState('');
  const [page, setPage] = useState(1);
  // Only one of these is set at a time; together they decide what the dialog shows.
  const [editing, setEditing] = useState<AdminStudent | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminStudent | null>(null);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState<StudentDraft>(blank);
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  // A problem found before uploading: the file is too big or is not an .xlsx workbook.
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['admin', 'students', q, grade, page], queryFn: () => adminStudents({ q, grade, page }), retry: false, staleTime: 0 });
  const signOutIfExpired = (error: Error | null) => { if (error instanceof AdminError && error.status === 401) onSignedOut(); };
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'students'] });
  const save = useMutation({
    mutationFn: () => saveStudent(editing === 'new' || editing === null ? null : editing.id, { ...draft, full_name: draft.full_name.trim(), class_name: draft.class_name.trim(), parent_name: draft.parent_name.trim(), parent_phone: draft.parent_phone.trim() }),
    onSuccess: () => { setEditing(null); setSaved(t('Student saved.')); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const remove = useMutation({
    mutationFn: (item: AdminStudent) => deleteStudent(item.id),
    onSuccess: () => { setDeleting(null); setSaved(t('Student removed.')); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  // Step one reads the workbook and reports what it contains; step two saves it.
  const preview = useMutation({ mutationFn: (chosen: File) => importStudents(chosen, false), onError: signOutIfExpired, retry: false });
  const commit = useMutation({
    mutationFn: (chosen: File) => importStudents(chosen, true),
    onSuccess: report => { closeImport(); setSaved(`${report.added} ${t('students added.')}`); setPage(1); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  const busy = save.isPending || remove.isPending || commit.isPending;
  const open = editing !== null || deleting !== null || importing;
  useEffect(() => { const timer = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    // A modal dialog focuses its first control (the close button); start in the name field instead.
    if (open && !dialog.current?.open) { dialog.current?.showModal(); nameInput.current?.focus(); }
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  useEffect(() => { if (deleting) cancelDelete.current?.focus(); }, [deleting]);
  useEffect(() => { signOutIfExpired(list.error); }, [list.error]);
  useEffect(() => { if (list.data && page > Math.max(1, Math.ceil(list.data.total / list.data.page_size))) setPage(Math.max(1, Math.ceil(list.data.total / list.data.page_size))); }, [list.data, page]);

  function compose(item: AdminStudent | 'new') {
    save.reset(); setErrors({}); setSaved(null);
    setDraft(item === 'new' ? blank : { full_name: item.full_name, grade: item.grade, class_name: item.class_name ?? '', birth_date: item.birth_date, parent_name: item.parent_name ?? '', parent_phone: item.parent_phone ?? '' });
    setEditing(item);
  }
  function confirmDelete(item: AdminStudent) { remove.reset(); setSaved(null); setDeleting(item); }
  function openImport() { preview.reset(); commit.reset(); setFile(null); setFileProblem(null); setSaved(null); setImporting(true); }
  function closeImport() { setImporting(false); setFile(null); setDragging(false); }
  function close() { if (!busy) { setEditing(null); setDeleting(null); closeImport(); } }
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
    if (draft.full_name.trim().length < 2) problems.full_name = 'Please enter the student’s full name.';
    if (!(draft.grade >= 1 && draft.grade <= 11)) problems.grade = 'Choose a grade from 1 to 11.';
    if (draft.birth_date && (draft.birth_date < '1990-01-01' || draft.birth_date > new Date().toISOString().slice(0, 10))) problems.birth_date = 'Please enter a valid date of birth.';
    const digits = draft.parent_phone.replace(/\D/g, '');
    if (draft.parent_phone.trim() && (!/^\+?[0-9 ().-]+$/.test(draft.parent_phone.trim()) || digits.length < 7 || digits.length > 15)) problems.parent_phone = 'Please enter a valid phone number with 7 to 15 digits.';
    setErrors(problems);
    if (!Object.values(problems).some(Boolean)) save.mutate();
  }
  function set<Key extends keyof StudentDraft>(key: Key, value: StudentDraft[Key]) { setDraft({ ...draft, [key]: value }); setErrors({ ...errors, [key]: undefined }); }
  function clear() { setSearch(''); setQ(''); setGrade(''); setPage(1); }
  function gradeName(value: number) { return locale === 'uz' ? `${value}-sinf` : locale === 'ru' ? `${value} класс` : `Grade ${value}`; }
  function className(item: { grade: number; class_name: string | null }) { return item.class_name ? `${gradeName(item.grade)} · ${item.class_name}` : gradeName(item.grade); }
  function birthDate(value: string | null) { return value ? new Intl.DateTimeFormat(locale === 'uz' ? 'uz-UZ' : locale === 'ru' ? 'ru-RU' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(value)) : null; }
  function errorMessage(error: Error | null) { return t(error instanceof AdminError ? error.message : 'The local admin service is unavailable. Please check that the backend is running.'); }
  const report: ImportReport | undefined = preview.data;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  const filtered = !!(q || grade);

  return <>
    <div className="admin-title"><div><p className="admin-eyebrow">{t('Admissions admin')}</p><h1>{t('Students')}</h1><p>{t('Keep the student list up to date: add students one by one or import an Excel file.')}</p></div><div className="admin-title-actions"><button type="button" className="admin-secondary" onClick={openImport}><ExcelIcon />{t('Import from Excel')}</button><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('Add student')} +</button></div></div>
    {saved && <p className="admin-success" role="status">{saved}</p>}
    <section className="admin-inbox" aria-label={t('Students')}>
      <div className="admin-toolbar"><label className="admin-search" htmlFor="student-search"><span className="sr-only">{t('Search students')}</span><span aria-hidden="true">⌕</span><input id="student-search" type="search" placeholder={t('Search by student, parent, or phone')} value={search} maxLength={200} onChange={event => setSearch(event.target.value)} /></label>
        <label className="admin-filter"><span className="sr-only">{t('Grade')}</span><select aria-label={t('Grade')} value={grade} onChange={event => { setGrade(event.target.value); setPage(1); }}><option value="">{t('All grades')}</option>{Array.from({ length: 11 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{gradeName(value)}</option>)}</select></label>
      </div>
      {list.isPending ? <div className="admin-empty" role="status">{t('Loading…')}</div> : list.isError ? <div className="admin-empty admin-error" role="alert"><p>{errorMessage(list.error)}</p><button className="admin-secondary" onClick={() => list.refetch()}>{t('Try again')}</button></div> : list.data.items.length ? <div className="admin-table-scroll"><table><thead><tr><th scope="col">{t('Student')}</th><th scope="col">{t('Class')}</th><th scope="col">{t('Parent or guardian')}</th><th scope="col"><span className="sr-only">{t('Edit')}</span></th></tr></thead><tbody>{list.data.items.map(item => <tr key={item.id}>
        <td><div className="admin-person"><span className="admin-avatar" aria-hidden="true">{item.full_name.trim().charAt(0).toUpperCase()}</span><span><strong>{item.full_name}</strong><span className="admin-email">{birthDate(item.birth_date) ?? '—'}</span></span></div></td>
        <td><span className="admin-class">{className(item)}</span></td>
        <td>{item.parent_name || item.parent_phone ? <>{item.parent_name && <span className="admin-parent">{item.parent_name}</span>}{item.parent_phone && <span className="admin-email">{item.parent_phone}</span>}</> : <span className="admin-email">{t('Not recorded')}</span>}</td>
        <td className="admin-row-actions"><button className="admin-view" onClick={() => compose(item)} aria-label={`${t('Edit')}: ${item.full_name}`}>{t('Edit')} ↗</button><button className="admin-delete-link" onClick={() => confirmDelete(item)} aria-label={`${t('Remove')}: ${item.full_name}`}>{t('Remove')}</button></td>
      </tr>)}</tbody></table></div> : <div className="admin-empty"><span aria-hidden="true">{filtered ? '↙' : '✎'}</span><h2>{t(filtered ? 'No matching students.' : 'No students yet.')}</h2><p>{t(filtered ? 'Try another search or clear your filters.' : 'Add students one by one or import your Excel list.')}</p>{filtered ? <button className="admin-secondary" onClick={clear}>{t('Clear filters')}</button> : <div className="admin-empty-actions"><button type="button" className="admin-secondary" onClick={openImport}><ExcelIcon />{t('Import from Excel')}</button><button type="button" className="admin-primary" onClick={() => compose('new')}>{t('Add student')} +</button></div>}</div>}
      <div className="admin-pagination"><span>{list.data?.total ?? 0} {t('results')} · {t('Page')} {page} {t('of')} {pages}</span><div><button className="admin-secondary" disabled={page === 1 || list.isFetching} onClick={() => setPage(page - 1)}>← {t('Previous')}</button><button className="admin-secondary" disabled={page >= pages || list.isFetching} onClick={() => setPage(page + 1)}>{t('Next')} →</button></div></div>
    </section>
    {/* Typed text and a chosen file are only discarded by an explicit Cancel or Close, never by a backdrop click. */}
    <dialog ref={dialog} className={deleting ? 'admin-dialog' : 'admin-dialog admin-dialog-wide'} aria-labelledby="student-dialog-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (deleting && event.target === event.currentTarget) close(); }}>
      {deleting ? <div className="admin-dialog-content">
        <p className="admin-eyebrow">{t('Remove student')}</p><h2 id="student-dialog-title">{t('Remove this student?')}</h2>
        <div className="admin-delete-target"><strong>{deleting.full_name}</strong><span>{className(deleting)}</span></div>
        <p className="admin-delete-warning">{t('This permanently removes the student and their parent’s contact details from the local database. This cannot be undone.')}</p>
        {remove.isError && <p className="admin-error" role="alert">{errorMessage(remove.error)}</p>}
        <div className="admin-confirm-actions"><button ref={cancelDelete} className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-danger" type="button" disabled={busy} onClick={() => remove.mutate(deleting)}>{t(remove.isPending ? 'Deleting…' : 'Delete permanently')}</button></div>
      </div> : importing ? <div className="admin-dialog-content">
        <div className="admin-dialog-top"><p className="admin-eyebrow">{t('Students')}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
        <h2 id="student-dialog-title">{t('Import students from Excel')}</h2>
        <p className="admin-limit-note" role="note"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.800" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 11v5.500M12 7.600v.100" /></svg><span><strong>{t('File limit')}</strong>{t('Each file can be up to 5 MB and hold up to 2,000 students. Only Excel .xlsx files are accepted.')}</span></p>
        <input ref={fileInput} className="sr-only" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" tabIndex={-1} aria-hidden="true" onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
        {!file ? <>
          <button type="button" className={dragging ? 'admin-dropzone dragging' : 'admin-dropzone'} onClick={() => fileInput.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}><ExcelIcon size={30} /><strong>{t('Choose an Excel file')}</strong><span>{t('or drag it here')}</span></button>
          <p className="admin-import-hint">{t('The file needs a column for the name and a column for the grade. Date of birth, parent, and phone are optional.')} {t('The first sheet is read.')}</p>
          <a className="admin-template-link" href={studentTemplateUrl} download>↓ {t('Download a template')}</a>
        </> : <>
          <div className="admin-file"><ExcelIcon /><span>{file.name}</span><button type="button" className="admin-view" disabled={busy || preview.isPending} onClick={() => fileInput.current?.click()}>{t('Choose another file')}</button></div>
          {fileProblem ? <p className="admin-error" role="alert">{t(fileProblem)}</p> : preview.isPending ? <p className="admin-import-status" role="status">{t('Reading the file…')}</p> : preview.isError ? <p className="admin-error" role="alert">{errorMessage(preview.error)}</p> : report && <>
            <div className="admin-import-summary"><div className="good"><strong>{report.added}</strong><span>{t('Will be added')}</span></div><div><strong>{report.duplicates}</strong><span>{t('Already in the list')}</span></div><div className={report.problem_count ? 'bad' : undefined}><strong>{report.problem_count}</strong><span>{t('Rows with problems')}</span></div></div>
            {report.added > 0 ? <div className="admin-import-list"><h3>{t('New students in this file')}</h3><ul>{report.preview.map((item, index) => <li key={index}><span>{item.full_name}</span><span>{className(item)}</span></li>)}</ul>{report.added > report.preview.length && <p>+ {report.added - report.preview.length} {t('and more')}</p>}</div> : <p className="admin-import-status">{t('Nothing new to add from this file.')}</p>}
            {report.problems.length > 0 && <div className="admin-import-list problems"><h3>{t('These rows will be skipped')}</h3><ul>{report.problems.map(problem => <li key={problem.row}><span>{t('Row')} {problem.row}{problem.name ? ` · ${problem.name}` : ''}</span><span>{t(problemReasons[problem.reason])}</span></li>)}</ul>{report.problem_count > report.problems.length && <p>+ {report.problem_count - report.problems.length} {t('and more')}</p>}</div>}
          </>}
          {commit.isError && <p className="admin-error" role="alert">{errorMessage(commit.error)}</p>}
        </>}
        <div className="admin-confirm-actions"><button className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button>{file && <button className="admin-primary" type="button" disabled={busy || !report || report.added === 0 || preview.isPending} onClick={() => commit.mutate(file)}>{commit.isPending ? t('Adding…') : `${t('Add students')}${report?.added ? ` (${report.added})` : ''}`}</button>}</div>
      </div> : editing && <form className="admin-dialog-content admin-notice-form" onSubmit={submit} noValidate>
        <div className="admin-dialog-top"><p className="admin-eyebrow">{t('Students')}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
        <h2 id="student-dialog-title">{t(editing === 'new' ? 'Add student' : 'Edit student')}</h2>
        <label htmlFor="student-name">{t('Full name')}<input id="student-name" ref={nameInput} value={draft.full_name} maxLength={120} autoComplete="off" onChange={event => set('full_name', event.target.value)} aria-invalid={!!errors.full_name} aria-describedby={errors.full_name ? 'student-name-error' : undefined} required />{errors.full_name && <span id="student-name-error" className="admin-field-error">{t(errors.full_name)}</span>}</label>
        <div className="admin-form-row">
          <label htmlFor="student-grade">{t('Grade')}<select id="student-grade" value={draft.grade || ''} onChange={event => set('grade', Number(event.target.value))} aria-invalid={!!errors.grade} aria-describedby={errors.grade ? 'student-grade-error' : undefined} required><option value="" disabled hidden>{t('Choose a grade')}</option>{Array.from({ length: 11 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{gradeName(value)}</option>)}</select>{errors.grade && <span id="student-grade-error" className="admin-field-error">{t(errors.grade)}</span>}</label>
          <label htmlFor="student-class">{t('Class letter')} <small>({t('Optional')})</small><input id="student-class" value={draft.class_name} maxLength={10} placeholder="A" autoComplete="off" onChange={event => set('class_name', event.target.value)} /></label>
          <label htmlFor="student-birth">{t('Date of birth')} <small>({t('Optional')})</small><input id="student-birth" type="date" min="1990-01-01" max={new Date().toISOString().slice(0, 10)} value={draft.birth_date ?? ''} onChange={event => set('birth_date', event.target.value || null)} aria-invalid={!!errors.birth_date} aria-describedby={errors.birth_date ? 'student-birth-error' : undefined} />{errors.birth_date && <span id="student-birth-error" className="admin-field-error">{t(errors.birth_date)}</span>}</label>
        </div>
        <div className="admin-form-row two">
          <label htmlFor="student-parent">{t('Parent or guardian')} <small>({t('Optional')})</small><input id="student-parent" value={draft.parent_name} maxLength={120} autoComplete="off" onChange={event => set('parent_name', event.target.value)} /></label>
          <label htmlFor="student-phone">{t('Parent’s phone')} <small>({t('Optional')})</small><input id="student-phone" type="tel" inputMode="tel" value={draft.parent_phone} maxLength={32} placeholder="+998 90 123 45 67" autoComplete="off" onChange={event => set('parent_phone', event.target.value)} aria-invalid={!!errors.parent_phone} aria-describedby={errors.parent_phone ? 'student-phone-error' : undefined} />{errors.parent_phone && <span id="student-phone-error" className="admin-field-error">{t(errors.parent_phone)}</span>}</label>
        </div>
        {save.isError && <p className="admin-error" role="alert">{errorMessage(save.error)}</p>}
        <div className="admin-confirm-actions"><button className="admin-secondary" type="button" disabled={busy} onClick={close}>{t('Cancel')}</button><button className="admin-primary" type="submit" disabled={busy}>{t(save.isPending ? 'Saving…' : 'Save student')}</button></div>
      </form>}
    </dialog>
  </>;
}

function ExcelIcon({ size = 15 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9.500 12.500l5 5M14.500 12.500l-5 5" /></svg>;
}
