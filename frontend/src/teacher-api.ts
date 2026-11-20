import { z } from 'zod';

const identity = z.object({ full_name: z.string(), subject: z.string(), login: z.string() });
export type TeacherIdentity = z.infer<typeof identity>;
export class TeacherError extends Error { constructor(public status: number, message: string) { super(message); } }

const UNAVAILABLE = 'Teacher sign-in is unavailable right now. Please try again later.';

async function request(path: string, options?: RequestInit) {
  let response: Response;
  // Checking a password is slow on purpose, so signing in is given a little longer than other requests.
  try { response = await fetch(`/api/teacher${path}`, { ...options, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new TeacherError(503, UNAVAILABLE); }
  if (!response.ok) {
    const messages: Record<number, string> = { 401: path === '/login' ? 'Incorrect login or password.' : 'Please sign in again.', 422: 'Incorrect login or password.', 429: 'Too many sign-in attempts. Try again in a minute.' };
    throw new TeacherError(response.status, messages[response.status] ?? UNAVAILABLE);
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
