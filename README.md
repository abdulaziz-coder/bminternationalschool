# BM International School

Local website using React 19, TypeScript, Tailwind CSS 4, Framer Motion, TanStack Query, and Zod. The backend uses FastAPI/Pydantic, SQLAlchemy, PostgreSQL, and a Python Temporal worker.

## Run on this Windows computer

From the project folder:

```powershell
npm run dev:all
```

Open http://127.0.0.1:3000. Keep the terminal running; Ctrl+C stops the processes started by the launcher. API docs: http://127.0.0.1:8000/docs. Temporal dashboard: http://127.0.0.1:8233.

The project-local setup downloads PostgreSQL and Temporal into ignored `.tools/` and keeps database files and service logs in ignored `.local/`. It does not install Windows services, modify the system PATH, or publish anything. The launcher refuses to replace existing website, API, or Temporal processes on the same ports.

### Windows terminal startup and shutdown

You can run `python scripts/dev.py` directly from the project folder to avoid npm's Windows batch wrapper. Wait for the startup messages and the website URL, then keep that terminal open while using the site. Press Ctrl+C only to stop. If npm asks `Terminate batch job (Y/N)?` after stopping, enter `Y`. The launcher checks PostgreSQL's status before shutdown, so a database that has already stopped does not trigger a duplicate stop attempt. Startup failures identify the service and its local log file.

The API automatically reloads changes in `backend/app/`, so new routes do not require a manual restart. An API reload signs admins out. Database schema upgrades still run through the initializer when the complete stack starts.

### Setup on a fresh Windows checkout

Requires Node.js 18.16+ (Node 22 recommended) and Python 3.13.

```powershell
npm ci
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.lock
npm run setup:services
npm run dev:all
```

### Frontend only

Run `npm run dev`. The website shows clearly marked preview learning content when the API is stopped. Enquiries can be downloaded as drafts; saving requires the backend. `npm run build` typechecks and produces `build/`; it does not deploy. `npm run preview` serves that build for visual preview only; API forwarding is configured for the development server.

## Docker alternative

With Docker Desktop installed and running, run `docker compose up --build`, then `npm run dev` in another terminal. Compose starts PostgreSQL, the Temporal development server, FastAPI, and the worker, with published ports bound to loopback. Database and Temporal state survive container restarts in named volumes. Use either Docker or native services, not both on the same ports. The native setup is the path used on this computer; Docker is an alternative configuration.

## Admissions data flow

The frontend supports English, Uzbek (Latin script), and Russian. The header language selector stores only the chosen language in `localStorage`; form drafts remain in React memory. Page metadata, navigation, learning content, FAQs, image descriptions, form labels, validation, status messages, and downloaded enquiry drafts follow that choice. Canonical English learning-stage values are preserved in API requests, so language changes require no database migration. Translations live in `frontend/src/translations.ts`.

1. A two-step React form validates with Zod and shows a review before submission. No draft details are stored in browser storage.
2. FastAPI validates again with Pydantic. Zod is a TypeScript library, so it runs on the frontend rather than inside Python.
3. PostgreSQL stores the enquiry and its pending-dispatch flag together. A stable idempotency key prevents duplicate rows on retries; changed data with a reused key returns HTTP 409.
4. The worker polls pending rows and starts a Temporal workflow using a deterministic workflow ID. Dispatch survives worker restarts, and completed workflow IDs cannot be reused.
5. A retryable, idempotent activity marks the enquiry `ready_for_review`. Only the enquiry ID enters workflow history, not personal details.
6. TanStack Query polls the receipt status. Receipt responses do not contain names, emails, or messages. There is no public enquiry list.

This local application sends no emails or school notifications. `ready_for_review` means prepared by the local workflow, not read by staff. Tables are created non-destructively by `app.init_db` for this initial version; future schema changes need migrations.

## Local admissions admin

Open http://127.0.0.1:3000/admin or use the footer's Admin panel link. Restart `python scripts/dev.py` once after this update to load the new backend routes. The initializer creates a local admin account on first startup and saves its sign-in details in `.local/admin-access.txt`. That file, the password-hash configuration, and all database files are ignored by Git. No fixed password is included in source code.

The panel supports English, Uzbek, and Russian; search by parent name, email, or enquiry reference; filters by grade and status; pagination; and a detail dialog with the complete message. Older enquiries without a grade show “Not recorded”. The detail dialog includes “Mark as received”, which saves a staff acknowledgement timestamp. Repeating the action keeps the original timestamp. This does not send emails or delete enquiries.

Admins can delete any enquiry from its row or detail dialog. A confirmation identifies the parent and short reference before permanently removing the enquiry and contact details. Cancelling leaves the enquiry unchanged. The protected DELETE endpoint is repeatable, list counts and pagination refresh after deletion, and queued activities finish safely if their enquiry was removed. Tests use isolated schemas; adding this feature does not remove any existing enquiries.

References are short, permanent codes such as `BM-000001`, generated by a unique PostgreSQL identity number. Existing enquiries receive codes during the initializer's repeatable upgrade; their internal UUIDs remain unchanged. Both the public confirmation and admin panel display the short code. UUIDs continue to identify API requests internally. The admin's “Received” status reflects staff acknowledgement, while “New” and “Ready for review” describe unacknowledged enquiries. Background Temporal updates cannot overwrite staff acknowledgement.

Authentication uses a password hash and an HttpOnly, SameSite=Strict session cookie. Sessions expire after eight hours and are invalidated when the API restarts or the password changes. Private responses have `Cache-Control: no-store`. Login attempts are limited and browser login/logout requests must come from an allowed local origin. Private enquiry records are not placed in browser localStorage.

To set your own password, run this from `backend/`:

```powershell
.venv/Scripts/python.exe -m app.admin_account
```

This prompts privately, invalidates previous sessions, and removes the initial generated-password note. In the Docker alternative, admin account files persist in the `admin_data` volume; view the initial note in your terminal with `docker compose exec api cat .local/admin-access.txt`. The native local setup is the verified path on this computer.

New admissions enquiries require a grade from 1 to 11. The selected grade is included in the review and downloaded draft and is validated by Zod, Pydantic, and a PostgreSQL check constraint. The initializer performs a repeatable additive upgrade for the grade column; existing enquiries are preserved with no grade recorded. Restart `python scripts/dev.py` after updating the backend so the initializer and new API contract take effect.

New enquiries also require a phone number. Common spaces, parentheses, and separators are accepted; 7–15 digits are required and formatting is normalized before saving. The number appears in the review, downloaded draft, and protected admin views and can be searched in the admin panel. The database upgrade preserves older enquiries without a phone number, which show “Not recorded”. Public receipt responses do not include contact information.

## Notices

The website has a Notices section (in the main navigation) for school news and admission guides, such as the guide for a new academic year. Visitors can filter by category; long notices collapse behind “Read more”, line breaks are kept, and web addresses become links.

Admins manage notices in the Notices tab of the admin panel (http://127.0.0.1:3000/admin#notices): post a notice, edit it, hide it by unticking “Show on the website” (it stays as a draft), or delete it after a confirmation. Important notices can be pinned, from the Pin button in the list or the checkbox in the editor: pinned notices are listed first on the website as highlighted full-width cards until they are unpinned. A notice has a category, a title of 3–160 characters, and up to 5,000 characters of plain text. In the editor an admin picks an existing category or creates a new one (2–40 characters); the website's filter buttons are built from the categories of the published notices. Typing an existing category in different capitals reuses it. The two starting categories, News and Admission guide, are translated; for a category an admin creates, the editor asks for its name in Uzbek, English, and Russian.

Notices are multilingual. The editor has a tab per site language (Uzbek, English, Russian); an admin writes the title and text in at least one and can add the others at any time. The list marks which languages each notice has. Visitors receive every notice in the language they are browsing in (`GET /api/notices?lang=uz|en|ru`); where that version has not been written, another language is shown instead (Uzbek readers get Russian, then English; Russian readers get Uzbek, then English; English readers get Uzbek, then Russian), so no notice is hidden for lack of a translation. Category names follow the same rule. Text is not machine-translated: each language is whatever the admin wrote. Notices posted before this change are kept as English. Notices are shown exactly as written in every site language; they are not translated.

`GET /api/notices` returns published notices only, newest first, with no management fields. `PATCH /api/admin/notices/{id}/pinned` pins or unpins one notice without changing its text or date. The protected `/api/admin/notices` endpoints use the same session cookie and origin check as the enquiry endpoints. The `notices` table is created by the initializer, so restart `python scripts/dev.py` once after this update.

## Students

The Students tab of the admin panel (http://127.0.0.1:3000/admin#students) keeps the school's student list. Admins add, edit, and remove students by hand; each student has a full name and grade (1–11), and optionally a class letter, date of birth, parent or guardian, and parent's phone. The list can be searched by student, parent, or phone and filtered by grade.

“Import from Excel” reads an `.xlsx` workbook (first sheet, up to 5 MB and 2,000 students); the dialog always shows this limit and refuses an oversized or non-`.xlsx` file before uploading it. The file is read first and a preview shows how many students will be added, how many are already in the list, and which rows have problems and why; nothing is saved until the admin confirms. The header row is found automatically, including below a title, and is recognised in English, Uzbek, and Russian. A column for the name and a column for the grade are required; a grade such as `5-A` also sets the class letter, and a name split across surname and first-name columns is joined. Students already in the list (same name, grade, and class) and repeats inside the file are skipped, so importing the same file twice adds nobody. A template can be downloaded from the import dialog. Older `.xls` files must be saved as `.xlsx` first.

Every student has a generated pass key (for example `K7QM-4XPD-9HTR`), which a parent will use to sign up. It is created when the student is added by hand or imported from Excel, and the initializer gives one to any student who has none. The key is always shown in the student table with a copy button, and the list can be searched by it; after adding or importing, the new keys are also shown together so they can be copied or downloaded as a list. A key keeps working until an admin presses “Generate pass key” for that student, which replaces it (`POST /api/admin/students/{id}/pass-key`). Keys are stored as readable text so admins can look them up, which means anyone with access to the admin panel or the database can read them. Restart `python scripts/dev.py` once after this update so the `pass_key` column is added and filled.

## Subjects

The Subjects tab of the admin panel (http://127.0.0.1:3000/admin#subjects) keeps the list of school subjects. Admins add, rename, and remove subjects and choose which grades (1–11) take each one, by tapping the grades or using the quick choices for all grades, 1–4, 5–9, and 10–11. A subject may be saved without grades and given them later. The list can be searched by name and filtered by grade. Two subjects cannot share a name, whatever the letter case or spacing.

The protected `/api/admin/subjects` endpoints list, create (`POST`), replace (`PUT /{id}`), and remove (`DELETE /{id}`) subjects; a subject is `{"name": "...", "grades": [1, 2, 3]}`. A teacher's subject is chosen from this list: the teacher form offers the subjects as a dropdown, the API refuses a subject that is not in the list, and an Excel import skips such rows and says why, so add the subjects before the teachers. A teacher added before the list existed keeps their subject until an admin picks another. Renaming a subject renames it for its teachers, the list shows how many teachers each subject has, and a subject cannot be removed while it still has teachers. Subjects are not shown on the public site. Restart `python scripts/dev.py` once after this update so the `subjects` table is created.

## Parent sign-in

Parents sign in at http://127.0.0.1:3000/parent (linked as “For parents” in the site header and footer) with nothing but their child's pass key. The field formats the key as it is typed or pasted, so letter case, spaces, and dashes do not matter. A wrong key is refused with the same message whether or not it looks like a key, and one address may try at most 8 wrong keys a minute. Nothing is shown to signed-in parents yet beyond a confirmation and a sign-out button; the parent pages are still to be built.

`POST /api/parent/login` takes `{"pass_key": "..."}` and sets an HttpOnly, SameSite=Strict cookie limited to `/api/parent`; `GET /api/parent/session` returns the child's name, grade, and class letter for the signed-in parent; `POST /api/parent/logout` ends the session. Sessions last 30 days, are kept in the API's memory (so restarting the API signs parents out), and end at once when an admin generates a new pass key for the student or removes the student. A parent session gives no access to the admin endpoints.

## Teacher sign-in

Teachers sign in at http://127.0.0.1:3000/teacher (linked as “For teachers” in the site footer) with the login and password generated in the Teachers tab of the admin panel. There is no sign-up: only teachers an admin has added can sign in. The login may be typed in any letter case; the password must be exact. An unknown login and a wrong password are refused with the same message and take the same time, and at most 5 wrong attempts a minute are allowed per address and per login. Nothing is shown to signed-in teachers yet beyond a confirmation with their name and subject and a sign-out button.

`POST /api/teacher/login` takes `{"login": "...", "password": "..."}` and sets an HttpOnly, SameSite=Strict cookie limited to `/api/teacher`; `GET /api/teacher/session` returns the signed-in teacher's name, subject, and login; `POST /api/teacher/logout` ends the session. Sessions last 7 days, are kept in the API's memory (so restarting the API signs teachers out), and end at once when an admin generates a new password for the teacher or removes the teacher. A teacher session gives no access to the admin or parent endpoints.

Student records are personal data about children: they are only available through the protected `/api/admin/students` endpoints and are never shown on the public website. Excel reading uses `openpyxl`; after updating, run `backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.lock` and restart `python scripts/dev.py` so the `students` table is created.

## Teachers

The Teachers tab of the admin panel (http://127.0.0.1:3000/admin#teachers) keeps the staff list. Admins add, edit, and remove teachers by hand or import them from an `.xlsx` workbook, the same way as students (preview before saving, headers in English, Uzbek, or Russian, duplicates skipped, a downloadable template). A teacher has a full name, the subject they teach, and an optional phone number; an import file needs a name column and a subject column and may hold up to 500 teachers.

Every teacher gets a generated sign-in for the future teacher pages. The login is built from the name in Latin letters (`karimova.zarina`, with a number added if it is taken) and does not change when the teacher is edited. The password is ten random characters without look-alikes such as `0` and `O`. It keeps working until an admin presses “Generate password” for that teacher, which replaces it.

Passwords are stored only as salted scrypt hashes, like the admin password, so they cannot be read back from the database or shown again later. They are displayed once, when generated: after adding a teacher, after generating a new password, and for the whole list after an import, where they can be copied or downloaded as a CSV file. A teacher sign-in endpoint is not part of this version; the stored login and hash are ready for it.

## Backend commands (manual startup)

From `backend/`, configure environment variables or copy `.env.example` to `.env`. Defaults match the native launcher. Run the initializer, then the API and worker in separate terminals:

```powershell
.venv/Scripts/python.exe -m app.init_db
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --loop app.runtime:loop_factory
.venv/Scripts/python.exe -m app.worker
```

## Validation

```powershell
npm run build
npm test
cd backend
.venv/Scripts/python.exe -m pytest tests -q
```

For PostgreSQL integration tests, start the local database and set the connection before pytest:

```powershell
$env:TEST_DATABASE_URL = 'postgresql+psycopg://bm:bm_local@127.0.0.1:5432/bm_school'
.venv/Scripts/python.exe -m pytest tests -q
```

The integration fixture creates and removes its own randomly named schema, leaving application data untouched.

## Source layout

- `frontend/src/`: React components, Zod contracts, queries, and styles.
- `frontend/public/`: supplied school logo and original campus illustration.
- `backend/app/`: API, database model, workflow, activity, and durable dispatcher.
- `backend/tests/`: request validation and PostgreSQL integration coverage.
- `scripts/`: native local setup and process launcher.
- `dist/`: retained original static prototype; React builds go to `build/`.

School curriculum, ages, addresses, and admissions policies remain draft until verified. Optional Google Fonts requests have system-font fallbacks. No GitHub push, hosting registration, deployment workflow, or publication is performed.

Photography: all current React sections use school photos supplied by the user, stored locally in frontend/public/photos/. Source records are in frontend/public/photos/SOURCES.md. Previously used stock files and the original static illustration are retained but are not displayed by the React site.
