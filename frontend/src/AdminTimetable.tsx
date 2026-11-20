import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from './i18n';
import { subjectLabel } from './subject-names';
import { AdminError, addLesson, classTimetable, removeLesson, timetableClasses, type LessonOption, type SchoolClass, type TimetableLesson } from './admin-api';

// The school week: Monday to Saturday, seven one-hour lessons from 08:00 to 15:00.
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const shortDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const periods = Array.from({ length: 7 }, (_, index) => index);
const grades = Array.from({ length: 11 }, (_, index) => index + 1);
const hour = (value: number) => `${String(value).padStart(2, '0')}:00`;
const time = (period: number) => `${hour(8 + period)}–${hour(9 + period)}`;
const STORAGE_KEY = 'bm-admin-timetable-class';
type ClassKey = { grade: number; class_name: string };

/** Each subject keeps the same colour everywhere, so a week can be read at a glance. */
function tone(subject: string) {
  let hash = 0;
  for (const character of subject) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `tt-tone-${hash % 8}`;
}
function savedClass(): ClassKey | null {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); return value && typeof value.grade === 'number' && typeof value.class_name === 'string' ? value : null; } catch { return null; }
}
function rememberClass(value: ClassKey) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Only a convenience. */ } }

/** The admin tab for weekly timetables: choose a class, pick a subject with its teacher, and place it in a free time. */
export default function AdminTimetable({ onSignedOut }: { onSignedOut: () => void }) {
  const { locale, t } = useLanguage();
  const client = useQueryClient();
  const [chosen, setChosen] = useState<ClassKey | null>(savedClass);
  const [other, setOther] = useState(false);
  const [otherGrade, setOtherGrade] = useState('');
  const [otherLetter, setOtherLetter] = useState('');
  const [otherError, setOtherError] = useState<string | null>(null);
  // The lesson being placed: one teacher with their subject.
  const [picked, setPicked] = useState<LessonOption | null>(null);
  const [search, setSearch] = useState('');
  const [day, setDay] = useState(() => Math.max(0, Math.min(5, new Date().getDay() - 1)));
  const [status, setStatus] = useState<string | null>(null);
  const classes = useQuery({ queryKey: ['admin', 'timetable', 'classes'], queryFn: timetableClasses, retry: false, staleTime: 0 });
  // Open the last class, or else the first one there is.
  const current = chosen ?? (classes.data?.[0] ? { grade: classes.data[0].grade, class_name: classes.data[0].class_name } : null);
  const week = useQuery({ queryKey: ['admin', 'timetable', current?.grade, current?.class_name], queryFn: () => classTimetable(current!.grade, current!.class_name), enabled: !!current, retry: false, staleTime: 0 });
  const signOutIfExpired = (error: Error | null) => { if (error instanceof AdminError && error.status === 401) onSignedOut(); };
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'timetable'] });
  const place = useMutation({
    mutationFn: (slot: { day: number; period: number }) => addLesson({ grade: current!.grade, class_name: current!.class_name, ...slot, teacher_id: picked!.teacher_id }),
    onSuccess: () => { setStatus(t('Lesson added.')); refresh(); }, onError: error => { signOutIfExpired(error); refresh(); }, retry: false,
  });
  const remove = useMutation({
    mutationFn: (item: TimetableLesson) => removeLesson(item.id),
    onSuccess: () => { setStatus(t('Lesson removed.')); refresh(); }, onError: signOutIfExpired, retry: false,
  });
  useEffect(() => { signOutIfExpired(classes.error ?? week.error); }, [classes.error, week.error]);
  useEffect(() => {
    if (!picked) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') setPicked(null); };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [picked]);
  // A lesson that can no longer be given to this class (its teacher was removed, say) is let go.
  useEffect(() => { if (picked && week.data && !week.data.options.some(option => option.teacher_id === picked.teacher_id)) setPicked(null); }, [week.data, picked]);

  function open(next: ClassKey) {
    setChosen(next); rememberClass(next); setPicked(null); setStatus(null); setSearch(''); place.reset(); remove.reset(); setOther(false);
  }
  function openOther(event: FormEvent) {
    event.preventDefault();
    const letter = otherLetter.trim().toUpperCase();
    if (!otherGrade) { setOtherError('Choose a grade from 1 to 11.'); return; }
    if (!/^[\p{L}\p{N}]{0,10}$/u.test(letter)) { setOtherError('A class letter may contain only letters and digits.'); return; }
    open({ grade: Number(otherGrade), class_name: letter });
  }
  function className(item: ClassKey) { return item.class_name ? `${item.grade}-${item.class_name}` : locale === 'uz' ? `${item.grade}-sinf` : locale === 'ru' ? `${item.grade} класс` : `${t('Grade')} ${item.grade}`; }
  function errorMessage(error: Error | null) { return t(error instanceof AdminError ? error.message : 'The local admin service is unavailable. Please check that the backend is running.'); }
  const label = (item: { subject: string; subject_names: Partial<Record<'uz' | 'en' | 'ru', string>> }) => subjectLabel({ name: item.subject, names: item.subject_names }, locale);
  const data = week.data;
  const lessons = data?.lessons ?? [];
  const at = (d: number, p: number) => lessons.find(item => item.day === d && item.period === p);
  const busyAt = (d: number, p: number) => picked ? data?.busy.find(item => item.teacher_id === picked.teacher_id && item.day === d && item.period === p) : undefined;
  const count = (teacherId: string) => lessons.filter(item => item.teacher_id === teacherId).length;
  const query = search.trim().toLowerCase();
  const options = (data?.options ?? []).filter(option => !query || [option.teacher_name, option.subject, ...Object.values(option.subject_names)].some(text => (text ?? '').toLowerCase().includes(query)))
    .sort((a, b) => label(a).localeCompare(label(b), locale) || a.teacher_name.localeCompare(b.teacher_name, locale));
  const known = (classes.data ?? []).some(item => current && item.grade === current.grade && item.class_name === current.class_name);
  const byGrade = grades.map(grade => [grade, (classes.data ?? []).filter(item => item.grade === grade)] as const).filter(([, items]) => items.length);
  const busy = place.isPending || remove.isPending;
  const problem = place.isError ? errorMessage(place.error) : remove.isError ? errorMessage(remove.error) : null;

  /** One time in the week: its lesson, a place for the picked lesson, or a sign that the picked teacher is busy then. */
  function cell(d: number, p: number): ReactNode {
    const item = at(d, p);
    const when = `${t(days[d])}, ${time(p)}`;
    if (item) return <div className={`tt-lesson ${tone(item.subject)}`}>
      <strong>{label(item)}</strong><span>{item.teacher_name}</span>
      <button type="button" className="tt-remove" disabled={busy} onClick={() => { setStatus(null); place.reset(); remove.mutate(item); }} aria-label={`${t('Remove lesson')}: ${label(item)}, ${when}`} title={t('Remove lesson')}>×</button>
    </div>;
    const elsewhere = busyAt(d, p);
    if (elsewhere) return <div className="tt-busy"><span>{t('Busy in')}</span><strong>{className(elsewhere)}</strong></div>;
    if (picked) return <button type="button" className={`tt-place ${tone(picked.subject)}`} disabled={busy} onClick={() => { setStatus(null); remove.reset(); place.mutate({ day: d, period: p }); }} aria-label={`${t('Place here')}: ${label(picked)} — ${picked.teacher_name}, ${when}`}><span aria-hidden="true">+</span><em aria-hidden="true">{t('Place here')}</em></button>;
    return <div className="tt-empty" aria-label={`${when}: ${t('Free')}`} />;
  }

  return <>
    <div className="admin-title"><div><p className="admin-eyebrow">{t('Admissions admin')}</p><h1>{t('Timetable')}</h1><p>{t('Weekly lessons for each class. Choose a class, pick a lesson, then click a free time.')}</p></div></div>

    <section className="admin-inbox tt-panel" aria-label={t('Class')}>
      <div className="admin-toolbar tt-class-bar">
        <label className="tt-class-picker" htmlFor="tt-class">{t('Class')}
          <select id="tt-class" value={other ? 'other' : current ? `${current.grade}|${current.class_name}` : ''} disabled={classes.isPending} onChange={event => {
            if (event.target.value === 'other') { setOther(true); setOtherError(null); return; }
            const [grade, letter] = event.target.value.split('|'); open({ grade: Number(grade), class_name: letter });
          }}>
            {!current && <option value="" disabled hidden>{t(classes.isPending ? 'Loading…' : 'Choose a class')}</option>}
            {current && !known && <option value={`${current.grade}|${current.class_name}`}>{className(current)}</option>}
            {byGrade.map(([grade, items]) => <optgroup key={grade} label={locale === 'uz' ? `${grade}-sinf` : locale === 'ru' ? `${grade} класс` : `${t('Grade')} ${grade}`}>{items.map((item: SchoolClass) => <option key={item.class_name} value={`${item.grade}|${item.class_name}`}>{className(item)} · {item.students} {t('students')}</option>)}</optgroup>)}
            <option value="other">{t('Another class…')}</option>
          </select>
        </label>
        {data && <p className="tt-summary" role="status"><strong>{className(data)}</strong> · {lessons.length} {t('lessons this week')}</p>}
      </div>
      {other && <form className="tt-other" onSubmit={openOther} noValidate>
        <label htmlFor="tt-other-grade">{t('Grade')}<select id="tt-other-grade" value={otherGrade} onChange={event => { setOtherGrade(event.target.value); setOtherError(null); }}><option value="" disabled hidden>{t('Choose a grade')}</option>{grades.map(grade => <option key={grade} value={grade}>{grade}</option>)}</select></label>
        <label htmlFor="tt-other-letter">{t('Class letter')} <small>({t('Optional')})</small><input id="tt-other-letter" value={otherLetter} maxLength={10} placeholder="A" autoComplete="off" onChange={event => { setOtherLetter(event.target.value); setOtherError(null); }} /></label>
        <div className="tt-other-actions"><button type="button" className="admin-secondary" onClick={() => setOther(false)}>{t('Cancel')}</button><button type="submit" className="admin-primary">{t('Open')}</button></div>
        {otherError && <p className="admin-field-error" role="alert">{t(otherError)}</p>}
      </form>}
      {classes.isError && <div className="admin-empty admin-error" role="alert"><p>{errorMessage(classes.error)}</p><button className="admin-secondary" onClick={() => classes.refetch()}>{t('Try again')}</button></div>}
      {classes.isSuccess && !current && !other && <div className="admin-empty"><span aria-hidden="true">▦</span><h2>{t('No classes yet.')}</h2><p>{t('Add students with their class in the Students tab, or open a class here.')}</p><button type="button" className="admin-primary" onClick={() => setOther(true)}>{t('Another class…')}</button></div>}
    </section>

    {current && <section className="tt" aria-label={`${t('Timetable')}: ${className(current)}`}>
      {week.isPending ? <div className="admin-empty" role="status">{t('Loading…')}</div> : week.isError ? <div className="admin-empty admin-error" role="alert"><p>{errorMessage(week.error)}</p><button className="admin-secondary" onClick={() => week.refetch()}>{t('Try again')}</button></div> : data && <>
        <div className="tt-palette">
          <div className="tt-palette-top"><h2>{t('Lessons for this class')}</h2>{data.options.length > 6 && <label className="admin-search tt-search" htmlFor="tt-search"><span className="sr-only">{t('Search lessons')}</span><span aria-hidden="true">⌕</span><input id="tt-search" type="search" value={search} maxLength={80} placeholder={t('Search by subject or teacher')} onChange={event => setSearch(event.target.value)} /></label>}</div>
          {data.options.length === 0 ? <p className="admin-form-note admin-form-warning">{t('No lessons can be added to this grade yet.')} {t('Give subjects this grade in the Subjects tab and add their teachers in the Teachers tab.')}</p>
            : <div className="tt-options" role="group" aria-label={t('Lessons for this class')}>{options.map(option => <button key={option.teacher_id} type="button" className={`tt-option ${tone(option.subject)}`} aria-pressed={picked?.teacher_id === option.teacher_id} onClick={() => { setStatus(null); place.reset(); setPicked(picked?.teacher_id === option.teacher_id ? null : option); }}>
              <strong>{label(option)}</strong><span>{option.teacher_name}</span>{count(option.teacher_id) > 0 && <b title={t('lessons this week')}>{count(option.teacher_id)}</b>}
            </button>)}</div>}
          <p className={picked ? 'tt-hint on' : 'tt-hint'} aria-live="polite">{picked ? <>{t('Placing')}: <strong>{label(picked)} — {picked.teacher_name}</strong>. {t('Click a free time. Press Esc to stop.')} <button type="button" className="admin-view" onClick={() => setPicked(null)}>{t('Cancel')}</button></> : data.options.length > 0 && t('Pick a lesson, then click a free time in the timetable.')}</p>
          {problem ? <p className="admin-error" role="alert">{problem}</p> : status && <p className="admin-success tt-status" role="status">{status}</p>}
        </div>

        {/* The full week, for screens with room for it. */}
        <div className="tt-week"><table>
          <thead><tr><th scope="col" className="tt-corner"><span>{t('Day')}</span><span>{t('Time')}</span></th>{periods.map(p => <th key={p} scope="col"><span>{p + 1}</span>{time(p)}</th>)}</tr></thead>
          <tbody>{days.map((name, d) => <tr key={name}><th scope="row">{t(name)}</th>{periods.map(p => <td key={p}>{cell(d, p)}</td>)}</tr>)}</tbody>
        </table></div>

        {/* One day at a time, for narrow screens. */}
        <div className="tt-day">
          <div className="tt-day-tabs" role="group" aria-label={t('Day')}>{shortDays.map((name, d) => <button key={name} type="button" aria-pressed={day === d} aria-label={t(days[d])} onClick={() => setDay(d)}>{t(name)}<small>{lessons.filter(item => item.day === d).length}</small></button>)}</div>
          <h3>{t(days[day])}</h3>
          <ol>{periods.map(p => <li key={p}><span className="tt-time"><b>{p + 1}</b>{time(p)}</span>{cell(day, p)}</li>)}</ol>
        </div>
      </>}
    </section>}
  </>;
}
