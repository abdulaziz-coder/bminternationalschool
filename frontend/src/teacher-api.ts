import { z } from 'zod';

const names = z.partialRecord(z.enum(['uz', 'en', 'ru']), z.string());
const identity = z.object({ full_name: z.string(), subject: z.string(), subject_names: names.default({}), login: z.string() });
export type TeacherIdentity = z.infer<typeof identity>;
export class TeacherError extends Error { constructor(public status: number, message: string) { super(message); } }

const UNAVAILABLE = 'Teacher sign-in is unavailable right now. Please try again later.';
const PAGES_UNAVAILABLE = 'The teacher pages are unavailable right now. Please try again later.';
// Why a register could not be opened or saved; the server answers with a short code.
const registerReasons: Record<string, string> = {
  lesson_not_found: 'This lesson is no longer in your timetable.', wrong_day: 'This lesson is not on that day.', future_date: 'This lesson has not happened yet.',
  unknown_student: 'The class list has changed. Please reopen the lesson.', duplicate_student: 'The class list has changed. Please reopen the lesson.',
};

async function request(path: string, options?: RequestInit) {
  const signIn = ['/login', '/session', '/logout'].includes(path);
  let response: Response;
  // Checking a password is slow on purpose, so signing in is given a little longer than other requests.
  try { response = await fetch(`/api/teacher${path}`, { ...options, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new TeacherError(503, signIn ? UNAVAILABLE : PAGES_UNAVAILABLE); }
  if (!response.ok) {
    if (!signIn && (response.status === 404 || response.status === 422)) {
      const code = await response.json().then(body => String(body?.detail), () => '');
      throw new TeacherError(response.status, registerReasons[code] ?? 'Please check the register and try again.');
    }
    const messages: Record<number, string> = { 401: path === '/login' ? 'Incorrect login or password.' : 'Please sign in again.', 422: 'Incorrect login or password.', 429: 'Too many sign-in attempts. Try again in a minute.' };
    throw new TeacherError(response.status, messages[response.status] ?? (signIn ? UNAVAILABLE : PAGES_UNAVAILABLE));
  }
  return response.status === 204 ? null : response.json();
}

/** The signed-in teacher, or null when nobody is signed in. */
export async function teacherSession() {
  try { return identity.parse(await request('/session')); }
  catch (error) { if (error instanceof TeacherError && error.status === 401) return null; throw error; }
}
export async function teacherLogin(login: string, password: string) {
  return identity.parse(await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) }));
}
export async function teacherLogout() { await request('/logout', { method: 'POST' }); }

const teacherLesson = z.object({ id: z.uuid(), day: z.number(), period: z.number(), date: z.string(), grade: z.number(), class_name: z.string(), subject: z.string(), subject_names: names, students: z.number(), recorded: z.boolean() });
const week = z.object({ week_start: z.string(), today: z.string(), lessons: z.array(teacherLesson) });
const attendance = z.enum(['present', 'late', 'absent']);
const register = z.object({
  lesson_id: z.uuid(), date: z.string(), day: z.number(), period: z.number(), grade: z.number(), class_name: z.string(), subject: z.string(), subject_names: names,
  editable: z.boolean(), saved_at: z.string().nullable(),
  students: z.array(z.object({ id: z.uuid(), full_name: z.string(), attendance: attendance.nullable(), score: z.number().nullable() })),
});
export type TeacherWeek = z.infer<typeof week>;
export type TeacherLesson = z.infer<typeof teacherLesson>;
export type Register = z.infer<typeof register>;
export type Attendance = z.infer<typeof attendance>;
export type Mark = { student_id: string; attendance: Attendance; score: number | null };

/** The teacher's lessons in the week containing `start` (this week when it is left out). */
export async function teacherWeek(start: string | null) {
  return week.parse(await request(`/timetable${start ? `?start=${start}` : ''}`));
}
/** The class list for one lesson on one date, with any attendance and grades already recorded. */
export async function lessonRegister(lessonId: string, date: string) {
  return register.parse(await request(`/lessons/${lessonId}/register?date=${date}`));
}
export async function saveRegister(lessonId: string, date: string, marks: Mark[]) {
  return register.parse(await request(`/lessons/${lessonId}/register?date=${date}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks }) }));
}
