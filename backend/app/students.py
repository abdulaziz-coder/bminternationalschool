"""Student records for admins: manual management and bulk import from an Excel workbook.

Every student has a generated pass key, which a parent uses to sign up. Admins see it in the list
and can replace it with a new one.
"""
from datetime import date, datetime, timezone
from io import BytesIO
import re
from typing import Annotated
from uuid import UUID
from zipfile import BadZipFile

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from openpyxl.utils.exceptions import InvalidFileException
from pydantic import ValidationError
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import AdminSession, check_origin, private_response, require_admin
from .db import StudentRecord, get_session
from .pass_keys import new_pass_key, normalise_pass_key
from .schemas import ImportProblem, StudentImportResult, StudentIn, StudentOut, StudentPage

router = APIRouter(prefix="/api/admin/students", tags=["Local admin"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[AdminSession, Depends(require_admin)]
UNAVAILABLE = "Local students database is unavailable."
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ROWS = 2000
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Header words that identify each column, in English, Uzbek, and Russian. Checked in this order,
# so "parent phone" is claimed by the phone column before the parent-name column sees it.
COLUMN_KEYWORDS = {
    "parent_phone": ("phone", "telefon", "tel.", "телефон", "mobile"),
    "birth_date": ("birth", "dob", "tug'il", "tugil", "рожд", "sana", "дата"),
    "parent_name": ("parent", "guardian", "ota-ona", "ota ona", "otasi", "onasi", "vasiy", "родител", "опекун", "мать", "отец"),
    "class_name": ("section", "letter", "harf", "буква", "литер"),
    "grade": ("grade", "class", "sinf", "класс"),
    "full_name": ("name", "student", "pupil", "ism", "familiya", "sharif", "f.i.sh", "f.i.o", "fio", "o'quvchi", "oquvchi", "фио", "ф.и.о", "имя", "фамил", "отчеств", "ученик", "учащ"),
}
TEMPLATE_HEADERS = ["Full name", "Grade", "Class letter", "Date of birth", "Parent or guardian", "Parent phone"]
TEMPLATE_EXAMPLE = ["Aliyev Vali", 5, "A", "2015-09-01", "Aliyev Sardor", "+998 90 123 45 67"]

def normalise(text) -> str:
    return " ".join(str(text or "").replace("‘", "'").replace("’", "'").replace("`", "'").replace("ʻ", "'").lower().split())


def map_columns(header: tuple, keywords_by_field: dict[str, tuple] | None = None) -> dict[str, list[int]]:
    """Matches header cells to fields (student fields by default); each column is used for at most one field.

    The name may be split over several columns (surname, first name, patronymic); all of them are kept, in sheet order.
    """
    columns: dict[str, list[int]] = {}
    used: set[int] = set()
    for field, keywords in (keywords_by_field or COLUMN_KEYWORDS).items():
        for index, cell in enumerate(header):
            label = normalise(cell)
            if label and index not in used and any(keyword in label for keyword in keywords):
                columns.setdefault(field, []).append(index)
                used.add(index)
                if field != "full_name":
                    break
    return columns


def parse_grade(value) -> tuple[int | None, str | None]:
    """Reads "5", 5.0, "5A", "5-A", or "5 «Б»" as a grade plus an optional class letter."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (int(value), None) if float(value).is_integer() else (None, None)
    match = re.fullmatch(r"\s*(\d{1,2})\s*[-–—./ ]*\s*[\"'«“]?\s*([^\W\d_]{1,3})?\s*[\"'»”]?\s*(?:sinf|класс|class|grade)?\s*", str(value or ""), re.IGNORECASE)
    if not match:
        return None, None
    return int(match.group(1)), (match.group(2) or "").upper() or None


def parse_date(value) -> date | None | bool:
    """Returns a date, None for an empty cell, or False when the cell cannot be read as a date."""
    if value is None or str(value).strip() == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for pattern in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d-%m-%Y", "%Y.%m.%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return False


def clean_phone(value) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    # Excel often stores phone numbers as numbers: 998901234567.0
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def student_key(full_name: str, grade: int, class_name: str | None) -> tuple:
    return normalise(full_name), grade, normalise(class_name)


def open_sheet(content: bytes, keywords: dict[str, tuple], required: tuple[str, ...]):
    """Opens the first sheet of an .xlsx workbook and finds its header row.

    Returns the remaining rows (an iterator positioned after the header), the column map, and the header's row number.
    """
    try:
        sheet = load_workbook(BytesIO(content), read_only=True, data_only=True).worksheets[0]
    except (BadZipFile, InvalidFileException, KeyError, IndexError, OSError, ValueError):
        raise HTTPException(400, "not_excel")
    rows = sheet.iter_rows(values_only=True)
    # The header may sit below a title; look for it in the first rows.
    for number, row in enumerate(rows, start=1):
        columns = map_columns(row, keywords)
        if all(field in columns for field in required):
            return rows, columns, number
        if number >= 15:
            break
    raise HTTPException(400, "missing_columns")


def read_workbook(content: bytes) -> tuple[list[tuple[int, StudentIn]], list[ImportProblem], int]:
    """Returns the valid students (with their sheet row numbers), the rows with problems, and the number of data rows."""
    rows, columns, header_number = open_sheet(content, COLUMN_KEYWORDS, ("full_name", "grade"))

    students: list[tuple[int, StudentIn]] = []
    problems: list[ImportProblem] = []
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
        if not name:
            problems.append(ImportProblem(row=number, reason="missing_name"))
            continue
        grade, letter = parse_grade(cell("grade"))
        if grade is None or not 1 <= grade <= 11:
            problems.append(ImportProblem(row=number, name=name, reason="bad_grade"))
            continue
        birth = parse_date(cell("birth_date"))
        if birth is False:
            problems.append(ImportProblem(row=number, name=name, reason="bad_date"))
            continue
        try:
            students.append((number, StudentIn(
                full_name=name, grade=grade, class_name=str(cell("class_name") or "").strip() or letter, birth_date=birth,
                parent_name=" ".join(str(cell("parent_name") or "").split()) or None, parent_phone=clean_phone(cell("parent_phone")),
            )))
        except ValidationError as error:
            field = error.errors()[0]["loc"][0]
            problems.append(ImportProblem(row=number, name=name, reason="bad_phone" if field == "parent_phone" else "bad_date" if field == "birth_date" else "bad_value"))
    return students, problems, total


@router.get("", response_model=StudentPage)
async def students(
    admin: Admin, db: Db, q: str = Query(default="", max_length=200), grade: int | None = Query(default=None, ge=1, le=11),
    page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=100),
):
    filters = []
    if q.strip():
        search = [StudentRecord.full_name.icontains(q.strip(), autoescape=True), StudentRecord.parent_name.icontains(q.strip(), autoescape=True)]
        phone_query = re.sub(r"[+ ().-]", "", q.strip())
        if phone_query.isascii() and phone_query.isdigit() and len(phone_query) >= 3:
            search.append(StudentRecord.parent_phone.contains(phone_query, autoescape=True))
        # A whole pass key, typed with or without dashes, finds its student.
        if normalise_pass_key(q):
            search.append(StudentRecord.pass_key == normalise_pass_key(q))
        filters.append(or_(*search))
    if grade is not None:
        filters.append(StudentRecord.grade == grade)
    try:
        total = await db.scalar(select(func.count()).select_from(StudentRecord).where(*filters))
        everyone = await db.scalar(select(func.count()).select_from(StudentRecord))
        records =(await db.scalars(select(StudentRecord).where(*filters).order_by(StudentRecord.grade, StudentRecord.class_name.nulls_first(), StudentRecord.full_name, StudentRecord.id).offset((page - 1) * page_size).limit(page_size))).all()
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    return {"items": records, "total": total, "page": page, "page_size": page_size, "all_students": everyone}


@router.post("", response_model=StudentOut, status_code=201)
async def create_student(payload: StudentIn, request: Request, admin: Admin, db: Db):
    """Adds a student with a newly generated pass key."""
    check_origin(request)
    record = StudentRecord(**payload.model_dump(), pass_key=new_pass_key())
    try:
        db.add(record)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return record


@router.get("/template")
def template(admin: Admin):
    """An example workbook with the expected columns."""
    book = Workbook()
    sheet = book.active
    sheet.title = "Students"
    sheet.append(TEMPLATE_HEADERS)
    sheet.append(TEMPLATE_EXAMPLE)
    for index, width in enumerate([30, 9, 9, 16, 30, 22], start=1):
        sheet.cell(row=1, column=index).font = Font(bold=True)
        sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = width
    output = BytesIO()
    book.save(output)
    return Response(output.getvalue(), media_type=XLSX, headers={"Content-Disposition": 'attachment; filename="students-template.xlsx"', "Cache-Control": "no-store"})


@router.post("/import", response_model=StudentImportResult)
async def import_students(request: Request, admin: Admin, db: Db, dry_run: bool = True):
    """Reads an .xlsx workbook sent as the request body. A dry run only reports; saving also returns the new pass keys."""
    check_origin(request)
    content = await request.body()
    if not content:
        raise HTTPException(400, "not_excel")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, "too_large")
    parsed, problems, total = read_workbook(content)
    pass_keys: list[dict] = []
    try:
        existing = {student_key(name, grade, class_name) for name, grade, class_name in (await db.execute(select(StudentRecord.full_name, StudentRecord.grade, StudentRecord.class_name))).all()}
        fresh: list[StudentIn] = []
        duplicates = 0
        for _number, student in parsed:
            key = student_key(student.full_name, student.grade, student.class_name)
            # Already enrolled, or listed twice in the file.
            if key in existing:
                duplicates += 1
                continue
            existing.add(key)
            fresh.append(student)
        if not dry_run and fresh:
            for student in fresh:
                key = new_pass_key()
                db.add(StudentRecord(**student.model_dump(), pass_key=key))
                pass_keys.append({"full_name": student.full_name, "grade": student.grade, "class_name": student.class_name, "pass_key": key})
            await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return {"rows": total, "added": len(fresh), "duplicates": duplicates, "problems": problems[:100], "problem_count": len(problems), "preview": fresh[:8], "saved": not dry_run, "pass_keys": pass_keys}


@router.put("/{student_id}", response_model=StudentOut)
async def update_student(student_id: UUID, payload: StudentIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        record = await db.get(StudentRecord, str(student_id))
        if record is None:
            raise HTTPException(404, "Student not found.")
        for field, value in payload.model_dump().items():
            setattr(record, field, value)
        record.updated_at = datetime.now(timezone.utc)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return record


@router.post("/{student_id}/pass-key", response_model=StudentOut)
async def generate_pass_key(student_id: UUID, request: Request, admin: Admin, db: Db):
    """Gives a student a new generated pass key; the earlier key stops working."""
    check_origin(request)
    try:
        record = await db.get(StudentRecord, str(student_id))
        if record is None:
            raise HTTPException(404, "Student not found.")
        record.pass_key = new_pass_key()
        record.updated_at = datetime.now(timezone.utc)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return record


@router.delete("/{student_id}", status_code=204)
async def delete_student(student_id: UUID, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        # Repeated requests are safe.
        await db.execute(delete(StudentRecord).where(StudentRecord.id == str(student_id)))
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
