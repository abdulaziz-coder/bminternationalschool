import { z } from 'zod';

const child = z.object({ full_name: z.string(), grade: z.number(), class_name: z.string().nullable() });
export type ParentChild = z.infer<typeof child>;
export class ParentError extends Error { constructor(public status: number, message: string) { super(message); } }

const UNAVAILABLE = 'Parent sign-in is unavailable right now. Please try again later.';

async function request(path: string, options?: RequestInit) {
  let response: Response;
  try { response = await fetch(`/api/parent${path}`, { ...options, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ParentError(503, UNAVAILABLE); }
  if (!response.ok) {
    const messages: Record<number, string> = { 401: path === '/login' ? 'This pass key was not recognised. Please check it and try again.' : 'Please sign in again.', 422: 'This pass key was not recognised. Please check it and try again.', 429: 'Too many sign-in attempts. Try again in a minute.' };
    throw new ParentError(response.status, messages[response.status] ?? UNAVAILABLE);
  }
  return response.status === 204 ? null : response.json();
}

/** The signed-in parent's child, or null when nobody is signed in. */
export async function parentSession() {
  try { return child.parse(await request('/session')); }
  catch (error) { if (error instanceof ParentError && error.status === 401) return null; throw error; }
}
export async function parentLogin(passKey: string) {
  return child.parse(await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass_key: passKey }) }));
}
export async function parentLogout() { await request('/logout', { method: 'POST' }); }

/** Shows a typed or pasted key as "ABCD-EFGH-JKMN": capitals, at most 12 characters, a dash after every four. */
export function formatPassKey(text: string) {
  return (text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12).match(/.{1,4}/g) ?? []).join('-');
}
