import { z } from 'zod';

const identity = z.object({ username: z.string() });
const detail = z.object({ id: z.uuid(), reference: z.string().regex(/^BM-\d{6,}$/), name: z.string(), email: z.string(), phone: z.string().nullable(), grade: z.number().nullable(), message: z.string(), created_at: z.string(), status: z.enum(['new', 'received', 'ready_for_review']), received_at: z.string().nullable() });
const pageSchema = z.object({ items: z.array(detail), total: z.number(), page: z.number(), page_size: z.number(), stats: z.object({ total: z.number(), received: z.number(), ready_for_review: z.number() }) });
export type AdminEnquiry = z.infer<typeof detail>;
export class AdminError extends Error { constructor(public status: number, message: string) { super(message); } }

async function request(path: string, options?: RequestInit) {
  let response: Response;
  try { response = await fetch(`/api/admin${path}`, { ...options, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new AdminError(503, 'The local admin service is unavailable. Please check that the backend is running.'); }
  if (!response.ok) {
    const noticeMessages: Record<number, string> = path.startsWith('/notices') ? { 404: 'This notice no longer exists.', 422: 'Please check the notice and try again.' } : {};
    const studentMessages: Record<number, string> = path.startsWith('/students') ? { 404: 'This student no longer exists.', 422: 'Please check the student’s details and try again.', 413: 'The file is larger than 5 MB.' } : {};
    if (path.startsWith('/students/import') && response.status === 400) {
      // The import endpoint explains why a workbook was refused with a short code.
      const reasons: Record<string, string> = { missing_columns: 'The file needs a column for the student’s name and a column for the grade.', too_many_rows: 'The file has more than 2,000 students. Please split it into smaller files.' };
      const code = await response.json().then(body => String(body?.detail), () => '');
      throw new AdminError(400, reasons[code] ?? 'This file could not be read. Please upload an Excel .xlsx file.');
    }
    const messages: Record<number, string> = { ...noticeMessages, ...studentMessages, 401: path === '/login' ? 'Incorrect username or password.' : 'Please sign in again.', 429: 'Too many sign-in attempts. Try again in a minute.', 503: path === '/login' ? 'Admin account is not configured. Run the local database initializer.' : 'The local admin service is unavailable. Please check that the backend is running.' };
    throw new AdminError(response.status, messages[response.status] ?? 'The local admin service is unavailable. Please check that the backend is running.');
  }
  return response.status === 204 ? null : response.json();
}
export async function adminSession() {
  try { return identity.parse(await request('/session')); }
  catch (error) { if (error instanceof AdminError && error.status === 401) return null; throw error; }
}
export async function adminLogin(username: string, password: string) { return identity.parse(await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })); }
export async function adminLogout() { await request('/logout', { method: 'POST' }); }
export async function adminEnquiries(filters: { q: string; grade: string; status: string; page: number }) {
  const params = new URLSearchParams({ page: String(filters.page), page_size: '25' });
  if (filters.q) params.set('q', filters.q);
  if (filters.grade) params.set('grade', filters.grade);
  if (filters.status) params.set('status', filters.status);
  return pageSchema.parse(await request(`/enquiries?${params}`));
}
export async function markEnquiryReceived(id: string) {
  return detail.parse(await request(`/enquiries/${id}/received`, { method: 'PATCH' }));
}
export async function deleteEnquiry(id: string) {
  await request(`/enquiries/${id}`, { method: 'DELETE' });
}

const notice = z.object({ id: z.uuid(), category: z.string(), title: z.string(), body: z.string(), published: z.boolean(), pinned: z.boolean(), published_at: z.string().nullable(), created_at: z.string(), updated_at: z.string() });
export type AdminNotice = z.infer<typeof notice>;
export type NoticeDraft = Pick<AdminNotice, 'category' | 'title' | 'body' | 'published' | 'pinned'>;
export async function adminNotices() { return z.array(notice).parse(await request('/notices')); }
/** Creates a notice, or replaces the one with the given id. */
export async function saveNotice(id: string | null, draft: NoticeDraft) {
  return notice.parse(await request(id ? `/notices/${id}` : '/notices', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }));
}
/** Pins or unpins a notice without changing anything else about it. */
export async function pinNotice(id: string, pinned: boolean) {
  return notice.parse(await request(`/notices/${id}/pinned`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) }));
}
export async function deleteNotice(id: string) {
  await request(`/notices/${id}`, { method: 'DELETE' });
}

const student = z.object({ id: z.uuid(), full_name: z.string(), grade: z.number(), class_name: z.string().nullable(), birth_date: z.string().nullable(), parent_name: z.string().nullable(), parent_phone: z.string().nullable() });
const studentPage = z.object({ items: z.array(student), total: z.number(), page: z.number(), page_size: z.number(), all_students: z.number() });
const importReport = z.object({
  rows: z.number(), added: z.number(), duplicates: z.number(), problem_count: z.number(), saved: z.boolean(),
  problems: z.array(z.object({ row: z.number(), name: z.string().nullable(), reason: z.enum(['missing_name', 'bad_grade', 'bad_date', 'bad_phone', 'bad_value']) })),
  preview: z.array(student.omit({ id: true })),
});
export type AdminStudent = z.infer<typeof student>;
export type StudentDraft = { full_name: string; grade: number; class_name: string; birth_date: string | null; parent_name: string; parent_phone: string };
export type ImportReport = z.infer<typeof importReport>;
export async function adminStudents(filters: { q: string; grade: string; page: number }) {
  const params = new URLSearchParams({ page: String(filters.page), page_size: '25' });
  if (filters.q) params.set('q', filters.q);
  if (filters.grade) params.set('grade', filters.grade);
  return studentPage.parse(await request(`/students?${params}`));
}
/** Adds a student, or replaces the one with the given id. */
export async function saveStudent(id: string | null, draft: StudentDraft) {
  return student.parse(await request(id ? `/students/${id}` : '/students', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }));
}
export async function deleteStudent(id: string) {
  await request(`/students/${id}`, { method: 'DELETE' });
}
/** Sends an Excel workbook. With `save` false the server only reports what the import would do. */
export async function importStudents(file: File, save: boolean) {
  return importReport.parse(await request(`/students/import?dry_run=${!save}`, { method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: file }));
}
export const studentTemplateUrl = '/api/admin/students/template';
