"""Teacher records for admins, with generated sign-in details for the teacher pages.

A teacher's subject is one of the subjects in the admin's subject list (see subjects.py).

Passwords are generated here, shown to the admin once, and stored only as salted scrypt hashes.
An admin who needs a teacher's password again resets it, which issues a new one.
"""
import asyncio
from datetime import datetime, timezone
from io import BytesIO
import re
import secrets
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from openpyxl import Workbook
from openpyxl.styles import Font
from pydantic import ValidationError
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import AdminSession, check_origin, hash_password, private_response, require_admin
from .db import TeacherRecord, get_session
from .schemas import TeacherCredentials, TeacherImportProblem, TeacherImportResult, TeacherIn, TeacherOut, TeacherPage
from .students import MAX_FILE_BYTES, XLSX, clean_phone, normalise, open_sheet
from .subjects import name_key, subject_names

router = APIRouter(prefix="/api/admin/teachers", tags=["Local admin"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[AdminSession, Depends(require_admin)]
UNAVAILABLE = "Local teachers database is unavailable."
# Each new teacher needs a deliberately slow password hash, so files are kept smaller than student files.
MAX_ROWS = 500
COLUMN_KEYWORDS = {
    "phone": ("phone", "telefon", "tel.", "телефон", "mobile"),
    "subject": ("subject", "fan", "предмет", "дисциплин", "teaches"),
    "full_name": ("name", "teacher", "ism", "familiya", "sharif", "f.i.sh", "f.i.o", "fio", "o'qituvchi", "oqituvchi", "фио", "ф.и.о", "имя", "фамил", "отчеств", "учител", "преподав"),
}
TEMPLATE_HEADERS = ["Full name", "Subject", "Phone"]
TEMPLATE_EXAMPLE = ["Karimova Zarina", "Mathematics", "+998 90 123 45 67"]
# No look-alike characters (0/O, 1/l/I), so a password can be read out or copied from paper.
PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CYRILLIC = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "x", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "", "ы": "i", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "ў": "o", "қ": "q", "ғ": "g", "ҳ": "h",
}


def new_password() -> str:
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(10))


def hashed(password: str) -> dict[str, str]:
    salt = secrets.token_bytes(16)
    return {"password_salt": salt.hex(), "password_hash": hash_password(password, salt)}


def login_base(full_name: str) -> str:
    """"Karimova Zarina Anvarovna" -> "karimova.zarina": the first two words, in plain Latin letters."""
    text = "".join(CYRILLIC.get(character, character) for character in normalise(full_name)).replace("'", "")
    words = [word for word in (re.sub(r"[^a-z0-9]", "", word) for word in text.split()) if word]
    return ".".join(words[:2])[:32] or "teacher"


def unique_login(full_name: str, taken: set[str]) -> str:
    base = login_base(full_name)
    login, number = base, 1
    while login in taken:
        number += 1
        login = f"{base}{number}"
    taken.add(login)
    return login


def teacher_key(full_name: str, subject: str) -> tuple:
    return normalise(full_name), normalise(subject)


def read_workbook(content: bytes) -> tuple[list[tuple[int, TeacherIn]], list[TeacherImportProblem], int]:
    """Returns the valid teachers (with their sheet row numbers), the rows with problems, and the number of data rows."""
    rows, columns, header_number = open_sheet(content, COLUMN_KEYWORDS, ("full_name", "subject"))
    teachers: list[tuple[int, TeacherIn]] = []
    problems: list[TeacherImportProblem] = []
    total = 0
    for number, row in enumerate(rows, start=header_number + 1):
        def cell(field):
            index = columns.get(field, [None])[0]
            return row[index] if index is not None and index < len(row) else None

        if all(value is None or str(value).strip() == "" for value in row):
            continue
        total += 1
        if total > MAX_ROWS:
            raise HTTPException(400, "too_many_rows")
        name = " ".join(" ".join(str(row[index] or "") for index in columns["full_name"] if index < len(row)).split())
        subject = " ".join(str(cell("subject") or "").split())
        if not name:
            problems.append(TeacherImportProblem(row=number, reason="missing_name"))
            continue
        if not subject:
            problems.append(TeacherImportProblem(row=number, name=name, reason="missing_subject"))
            continue
        try:
            teachers.append((number, TeacherIn(full_name=name, subject=subject, phone=clean_phone(cell("phone")))))
        except ValidationError as error:
            problems.append(TeacherImportProblem(row=number, name=name, reason="bad_phone" if error.errors()[0]["loc"][0] == "phone" else "bad_value"))
    return teachers, problems, total


async def taken_logins(db: AsyncSession) -> set[str]:
    return set((await db.scalars(select(TeacherRecord.login))).all())


@router.get("", response_model=TeacherPage)
async def teachers(admin: Admin, db: Db, q: str = Query(default="", max_length=200), page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=100)):
    filters = []
    if q.strip():
        search = [TeacherRecord.full_name.icontains(q.strip(), autoescape=True), TeacherRecord.subject.icontains(q.strip(), autoescape=True), TeacherRecord.login.icontains(q.strip(), autoescape=True)]
        phone_query = re.sub(r"[+ ().-]", "", q.strip())
        if phone_query.isascii() and phone_query.isdigit() and len(phone_query) >= 3:
            search.append(TeacherRecord.phone.contains(phone_query, autoescape=True))
        filters.append(or_(*search))
    try:
        total = await db.scalar(select(func.count()).select_from(TeacherRecord).where(*filters))
        records = (await db.scalars(select(TeacherRecord).where(*filters).order_by(TeacherRecord.full_name, TeacherRecord.id).offset((page - 1) * page_size).limit(page_size))).all()
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    return {"items": records, "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=TeacherCredentials, status_code=201)
async def create_teacher(payload: TeacherIn, request: Request, admin: Admin, db: Db):
    """Adds a teacher and returns the generated login and password. The password is never retrievable again."""
    check_origin(request)
    password = new_password()
    try:
        subject = (await subject_names(db)).get(name_key(payload.subject))
        if subject is None:
            raise HTTPException(422, "unknown_subject")
        record = TeacherRecord(**{**payload.model_dump(), "subject": subject}, login=unique_login(payload.full_name, await taken_logins(db)), **hashed(password))
        db.add(record)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return {"teacher": record, "password": password}


@router.get("/template")
def template(admin: Admin):
    book = Workbook()
    sheet = book.active
    sheet.title = "Teachers"
    sheet.append(TEMPLATE_HEADERS)
    sheet.append(TEMPLATE_EXAMPLE)
    for index, width in enumerate([32, 26, 22], start=1):
        sheet.cell(row=1, column=index).font = Font(bold=True)
        sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = width
    output = BytesIO()
    book.save(output)
    return Response(output.getvalue(), media_type=XLSX, headers={"Content-Disposition": 'attachment; filename="teachers-template.xlsx"', "Cache-Control": "no-store"})


@router.post("/import", response_model=TeacherImportResult)
async def import_teachers(request: Request, admin: Admin, db: Db, dry_run: bool = True):
    """Reads an .xlsx workbook sent as the request body. A dry run only reports; saving also returns the new sign-in details."""
    check_origin(request)
    content = await request.body()
    if not content:
        raise HTTPException(400, "not_excel")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, "too_large")
    parsed, problems, total = read_workbook(content)
    credentials: list[dict] = []
    try:
        existing = {teacher_key(name, subject) for name, subject in (await db.execute(select(TeacherRecord.full_name, TeacherRecord.subject))).all()}
        subjects = await subject_names(db)
        fresh: list[TeacherIn] = []
        duplicates = 0
        for number, teacher in parsed:
            subject = subjects.get(name_key(teacher.subject))
            if subject is None:
                # Only subjects from the admin's subject list can be given to a teacher.
                problems.append(TeacherImportProblem(row=number, name=teacher.full_name, reason="unknown_subject"))
                continue
            teacher = teacher.model_copy(update={"subject": subject})
            key = teacher_key(teacher.full_name, teacher.subject)
            # Already on the staff list, or listed twice in the file.
            if key in existing:
                duplicates += 1
                continue
            existing.add(key)
            fresh.append(teacher)
        problems.sort(key=lambda problem: problem.row)
        if not dry_run and fresh:
            taken = await taken_logins(db)
            passwords = [new_password() for _ in fresh]
            # Hashing is slow on purpose; keep the server responsive while a whole staff list is processed.
            hashes = await asyncio.to_thread(lambda: [hashed(password) for password in passwords])
            for teacher, password, secret in zip(fresh, passwords, hashes):
                record = TeacherRecord(**teacher.model_dump(), login=unique_login(teacher.full_name, taken), **secret)
                db.add(record)
                credentials.append({"full_name": record.full_name, "subject": record.subject, "login": record.login, "password": password})
            await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return {"rows": total, "added": len(fresh), "duplicates": duplicates, "problems": problems[:100], "problem_count": len(problems), "preview": fresh[:8], "saved": not dry_run, "credentials": credentials}


@router.put("/{teacher_id}", response_model=TeacherOut)
async def update_teacher(teacher_id: UUID, payload: TeacherIn, request: Request, admin: Admin, db: Db):
    """Changes a teacher's details. The login stays the same so existing sign-in details keep working."""
    check_origin(request)
    try:
        record = await db.get(TeacherRecord, str(teacher_id))
        if record is None:
            raise HTTPException(404, "Teacher not found.")
        # A teacher added before the subject list existed may keep the subject they already have.
        subject = (await subject_names(db)).get(name_key(payload.subject)) or (payload.subject if payload.subject == record.subject else None)
        if subject is None:
            raise HTTPException(422, "unknown_subject")
        for field, value in {**payload.model_dump(), "subject": subject}.items():
            setattr(record, field, value)
        record.updated_at = datetime.now(timezone.utc)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return record


@router.post("/{teacher_id}/password", response_model=TeacherCredentials)
async def reset_password(teacher_id: UUID, request: Request, admin: Admin, db: Db):
    """Replaces a teacher's password with a new generated one; the old password stops working."""
    check_origin(request)
    password = new_password()
    try:
        record = await db.get(TeacherRecord, str(teacher_id))
        if record is None:
            raise HTTPException(404, "Teacher not found.")
        for field, value in hashed(password).items():
            setattr(record, field, value)
        record.updated_at = datetime.now(timezone.utc)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return {"teacher": record, "password": password}


@router.delete("/{teacher_id}", status_code=204)
async def delete_teacher(teacher_id: UUID, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        # Repeated requests are safe. Removing a teacher also removes their sign-in.
        await db.execute(delete(TeacherRecord).where(TeacherRecord.id == str(teacher_id)))
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
