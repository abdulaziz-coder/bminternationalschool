import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from './i18n';
import { longDate } from './dates';
import { subjectLabel } from './subject-names';
import { lessonRegister, saveRegister, teacherWeek, TeacherError, type Attendance, type Register, type TeacherIdentity, type TeacherLesson } from './teacher-api';

// The school week: Monday to Saturday, seven one-hour lessons from 08:00 to 15:00, as in the admin's timetable.
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const shortDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const periods = Array.from({ length: 7 }, (_, index) => index);
const hour = (value: number) => `${String(value).padStart(2, '0')}:00`;
const time = (period: number) => `${hour(8 + period)}–${hour(9 + period)}`;
const choices: { value: Attendance; label: string; mark: string }[] = [{ value: 'present', label: 'Present', mark: '✓' }, { value: 'late', label: 'Late', mark: '◷' }, { value: 'absent', label: 'Absent', mark: '✕' }];
const MAX_SCORE = 5;

/** Dates travel as "2026-11-16"; these work on them in local time, so a date never shifts by a day. */
const parse = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const addDays = (value: string, count: number) => { const date = parse(value); date.setDate(date.getDate() + count); return iso(date); };
const short = (value: string) => { const date = parse(value); return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`; };
const className = (item: { grade: number; class_name: string }) => item.class_name ? `${item.grade}-${item.class_name}` : `${item.grade}`;
type Row = { attendance: Attendance; score: string };

/** A signed-in teacher's week. Each lesson opens its register: who is present, late, or absent, and any grades given. */
export default function TeacherHome({ teacher, onSignedOut }: { teacher: TeacherIdentity; onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  const [start, setStart] = useState<string | null>(null);
  const [opened, setOpened] = useState<TeacherLesson | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [day, setDay] = useState(() => Math.max(0, Math.min(5, new Date().getDay() - 1)));
  const week = useQuery({ queryKey: ['teacher', 'week', start], queryFn: () => teacherWeek(start), retry: false, staleTime: 0, placeholderData: previous => previous });
  useEffect(() => { if (week.error instanceof TeacherError && week.error.status === 401) onSignedOut(); }, [week.error]);
  const data = week.data;
  const at = (d: number, p: number) => data?.lessons.find(item => item.day === d && item.period === p);
  const subject = subjectLabel({ name: teacher.subject, names: teacher.subject_names }, locale);
  const thisWeek = data && start !== null && data.week_start !== addDays(data.today, -((parse(data.today).getDay() + 6) % 7));
  function move(weeks: number) { if (data) { setStart(addDays(data.week_start, weeks * 7)); setStatus(null); } }

  function cell(d: number, p: number): ReactNode {
    const item = at(d, p);
    if (!item) return <div className="tt-empty" aria-label={`${t(days[d])}, ${time(p)}: ${t('Free')}`} />;
    const upcoming = data && item.date > data.today;
    return <button type="button" className={`tt-lesson tt-open tt-tone-0${upcoming ? ' upcoming' : ''}${item.recorded ? ' recorded' : ''}`} onClick={() => { setStatus(null); setOpened(item); }}
      aria-label={`${className(item)}, ${subject}, ${t(days[d])} ${short(item.date)}, ${time(p)}. ${t(item.recorded ? 'Register saved' : upcoming ? 'Not yet' : 'Register not filled in')}`}>
      <strong>{className(item)}</strong><span>{subject}</span>
      <em>{item.recorded ? <>✓ {t('Saved')}</> : upcoming ? t('Not yet') : `${item.students} ${t('students')}`}</em>
    </button>;
  }

  return <>
    <section className="tp-welcome" aria-labelledby="tp-title">
      <span className="admin-avatar" aria-hidden="true">{teacher.full_name.trim().charAt(0).toUpperCase()}</span>
      <div><p className="admin-eyebrow">{t('For teachers')}</p><h1 id="tp-title">{teacher.full_name}</h1><p>{subject}</p></div>
    </section>
    {status && <p className="admin-success" role="status">{status}</p>}
    <section className="tt tp-week" aria-label={t('My timetable')}>
      <div className="tp-week-top">
        <div><h2>{t('My timetable')}</h2><p>{t('Open a lesson to mark attendance and give grades.')}</p></div>
        <div className="tp-week-nav" role="group" aria-label={t('Week')}>
          <button type="button" className="admin-secondary" disabled={!data} onClick={() => move(-1)} aria-label={t('Previous week')}>←</button>
          <span>{data ? `${short(data.week_start)} – ${short(addDays(data.week_start, 5))}.${parse(data.week_start).getFullYear()}` : '…'}</span>
          <button type="button" className="admin-secondary" disabled={!data} onClick={() => move(1)} aria-label={t('Next week')}>→</button>
          {thisWeek && <button type="button" className="admin-view" onClick={() => { setStart(null); setStatus(null); }}>{t('This week')}</button>}
        </div>
      </div>
      {week.isPending ? <div className="admin-empty" role="status">{t('Loading…')}</div> : week.isError ? <div className="admin-empty admin-error" role="alert"><p>{t(week.error instanceof TeacherError ? week.error.message : 'The teacher pages are unavailable right now. Please try again later.')}</p><button className="admin-secondary" onClick={() => week.refetch()}>{t('Try again')}</button></div> : data && <>
        {data.lessons.length === 0 && <p className="admin-form-note">{t('You have no lessons in the timetable yet. The school office adds them.')}</p>}
        <div className="tt-week"><table>
          <thead><tr><th scope="col" className="tt-corner"><span>{t('Day')}</span><span>{t('Time')}</span></th>{periods.map(p => <th key={p} scope="col"><span>{p + 1}</span>{time(p)}</th>)}</tr></thead>
          <tbody>{days.map((name, d) => { const date = addDays(data.week_start, d); return <tr key={name} className={date === data.today ? 'tp-today' : undefined}><th scope="row">{t(name)}<small>{short(date)}{date === data.today && <b> · {t('Today')}</b>}</small></th>{periods.map(p => <td key={p}>{cell(d, p)}</td>)}</tr>; })}</tbody>
        </table></div>
        <div className="tt-day">
          <div className="tt-day-tabs" role="group" aria-label={t('Day')}>{shortDays.map((name, d) => { const date = addDays(data.week_start, d); return <button key={name} type="button" aria-pressed={day === d} className={date === data.today ? 'tp-today' : undefined} aria-label={`${t(days[d])} ${short(date)}`} onClick={() => setDay(d)}>{t(name)}<small>{short(date)}</small></button>; })}</div>
          <h3>{t(days[day])} <small>{longDate(locale, `${addDays(data.week_start, day)}T00:00:00`)}</small></h3>
          <ol>{periods.map(p => <li key={p}><span className="tt-time"><b>{p + 1}</b>{time(p)}</span>{cell(day, p)}</li>)}</ol>
        </div>
      </>}
    </section>
    {opened && <RegisterDialog lesson={opened} subject={subject} onClose={() => setOpened(null)} onSignedOut={onSignedOut} onSaved={saved => {
      setOpened(null); setStatus(`${t('Register saved')}: ${className(saved)}, ${t(days[saved.day])} ${short(saved.date)}, ${time(saved.period)}.`);
      client.invalidateQueries({ queryKey: ['teacher', 'week'] });
    }} />}
  </>;
}

/** One lesson on one date: every student of the class, with attendance and an optional grade. */
function RegisterDialog({ lesson, subject, onClose, onSaved, onSignedOut }: { lesson: TeacherLesson; subject: string; onClose: () => void; onSaved: (saved: Register) => void; onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [initial, setInitial] = useState<Record<string, Row>>({});
  const [leaving, setLeaving] = useState(false);
  const register = useQuery({ queryKey: ['teacher', 'register', lesson.id, lesson.date], queryFn: () => lessonRegister(lesson.id, lesson.date), retry: false, staleTime: 0 });
  const save = useMutation({
    mutationFn: () => saveRegister(lesson.id, lesson.date, Object.entries(rows).map(([student_id, row]) => ({ student_id, attendance: row.attendance, score: row.attendance === 'absent' || !row.score ? null : Number(row.score) }))),
    onSuccess: saved => { client.setQueryData(['teacher', 'register', lesson.id, lesson.date], saved); onSaved(saved); },
    onError: error => { if (error instanceof TeacherError && error.status === 401) onSignedOut(); }, retry: false,
  });
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { if (register.error instanceof TeacherError && register.error.status === 401) onSignedOut(); }, [register.error]);
  // Unrecorded students start as present, so a teacher only marks who is late or absent.
  useEffect(() => {
    if (!register.data) return;
    const start = Object.fromEntries(register.data.students.map(student => [student.id, { attendance: student.attendance ?? 'present', score: student.score === null ? '' : String(student.score) }]));
    setRows(start); setInitial(start);
  }, [register.data]);
  const data = register.data;
  const editable = !!data?.editable;
  const changed = JSON.stringify(rows) !== JSON.stringify(initial) || (!!data && data.saved_at === null && data.students.length > 0);
  const counts = choices.map(choice => Object.values(rows).filter(row => row.attendance === choice.value).length);
  function set(id: string, patch: Partial<Row>) { setRows(current => ({ ...current, [id]: { ...current[id], ...patch } })); setLeaving(false); }
  function close() { if (save.isPending) return; if (editable && changed && !leaving) { setLeaving(true); return; } dialog.current?.close(); onClose(); }
  // Arrow keys move between the three attendance boxes of a student, as in any radio group.
  function arrows(event: KeyboardEvent<HTMLDivElement>, id: string) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step || !editable) return;
    event.preventDefault();
    const index = (choices.findIndex(choice => choice.value === rows[id].attendance) + step + choices.length) % choices.length;
    set(id, { attendance: choices[index].value });
    (event.currentTarget.children[index] as HTMLButtonElement | undefined)?.focus();
  }
  const when = `${t(days[lesson.day])}, ${longDate(locale, `${lesson.date}T00:00:00`)} · ${time(lesson.period)}`;
  const savedAt = data?.saved_at ? new Intl.DateTimeFormat(locale === 'uz' ? 'uz-UZ' : locale === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(data.saved_at)) : null;

  return <dialog ref={dialog} className="admin-dialog admin-dialog-wide rg" aria-labelledby="rg-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="admin-dialog-content">
      <div className="admin-dialog-top"><p className="admin-eyebrow">{subject}</p><button type="button" className="admin-close" aria-label={t('Close')} onClick={close}>×</button></div>
      <h2 id="rg-title">{className(lesson)}</h2>
      <p className="rg-when">{when}</p>
      {register.isPending ? <p className="admin-import-status" role="status">{t('Loading…')}</p> : register.isError ? <div className="admin-error" role="alert"><p>{t(register.error instanceof TeacherError ? register.error.message : 'The teacher pages are unavailable right now. Please try again later.')}</p><button className="admin-secondary" onClick={() => register.refetch()}>{t('Try again')}</button></div> : data && <>
        {!editable && <p className="admin-form-note admin-form-warning" role="note">{t('This lesson has not happened yet. Its register can be filled in on the day.')}</p>}
        {data.students.length === 0 ? <p className="admin-form-note">{t('There are no students in this class yet. The school office adds them.')}</p> : <>
          <div className="rg-bar">
            <div className="rg-counts" aria-live="polite">{choices.map((choice, index) => <span key={choice.value} className={`rg-count ${choice.value}`}><i aria-hidden="true">{choice.mark}</i>{t(choice.label)} <b>{counts[index]}</b></span>)}</div>
            {editable && <button type="button" className="admin-view" disabled={counts[0] === data.students.length} onClick={() => setRows(current => Object.fromEntries(Object.entries(current).map(([id, row]) => [id, { ...row, attendance: 'present' as Attendance }])))}>{t('Mark everyone present')}</button>}
          </div>
          <div className="rg-head" aria-hidden="true"><span>{t('Student')}</span><span>{t('Attendance')}</span><span>{t('Mark')} 1–{MAX_SCORE}</span></div>
          <ol className="rg-list">{data.students.map((student, index) => {
            const row = rows[student.id];
            if (!row) return null;
            return <li key={student.id} className={`rg-row ${row.attendance}`}>
              <span className="rg-name"><b>{index + 1}</b>{student.full_name}</span>
              <div className="rg-att" role="radiogroup" aria-label={`${t('Attendance')}: ${student.full_name}`} onKeyDown={event => arrows(event, student.id)}>
                {choices.map(choice => <button key={choice.value} type="button" role="radio" aria-checked={row.attendance === choice.value} tabIndex={row.attendance === choice.value ? 0 : -1} disabled={!editable} className={choice.value} onClick={() => set(student.id, { attendance: choice.value })}><i aria-hidden="true">{choice.mark}</i>{t(choice.label)}</button>)}
              </div>
              <label className="rg-score"><span className="sr-only">{t('Mark')}: {student.full_name}</span>
                <input value={row.attendance === 'absent' ? '' : row.score} inputMode="numeric" maxLength={1} placeholder="—" autoComplete="off" disabled={!editable || row.attendance === 'absent'} title={row.attendance === 'absent' ? t('An absent student cannot be given a grade.') : t('Optional')}
                  onChange={event => set(student.id, { score: event.target.value.replace(new RegExp(`[^1-${MAX_SCORE}]`, 'g'), '').slice(-1) })} />
              </label>
            </li>;
          })}</ol>
        </>}
        {leaving && <p className="admin-form-note admin-form-warning rg-leave" role="alert">{t('You have changes that are not saved.')} <button type="button" className="admin-view" onClick={close}>{t('Close without saving')}</button></p>}
        {save.isError && <p className="admin-error" role="alert">{t(save.error instanceof TeacherError ? save.error.message : 'The teacher pages are unavailable right now. Please try again later.')}</p>}
        <div className="admin-confirm-actions rg-actions">
          <span className="rg-saved">{savedAt ? `${t('Last saved')}: ${savedAt}` : data.students.length > 0 && editable ? t('Not saved yet') : ''}</span>
          <button type="button" className="admin-secondary" disabled={save.isPending} onClick={close}>{t(editable ? 'Cancel' : 'Close')}</button>
          {editable && data.students.length > 0 && <button type="button" className="admin-primary" disabled={save.isPending} onClick={() => save.mutate()}>{t(save.isPending ? 'Saving…' : 'Save register')}</button>}
        </div>
      </>}
    </div>
  </dialog>;
}
