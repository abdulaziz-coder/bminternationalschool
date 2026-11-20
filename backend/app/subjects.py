"""School subjects for admins: each subject has a name in Uzbek, English, and/or Russian, and the grades (1-11) that take it.

Teachers are given one of these subjects. A teacher's record holds the subject's main name (the Uzbek name,
else the English, else the Russian one), so renaming a subject renames it for its teachers too, and a
subject that still has teachers cannot be removed. No two subjects share a name in any language.
"""
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import AdminSession, check_origin, private_response, require_admin
from .db import SubjectRecord, TeacherRecord, get_session
from .schemas import LANGUAGES, SubjectIn, SubjectOut

router = APIRouter(prefix="/api/admin/subjects", tags=["Local admin"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[AdminSession, Depends(require_admin)]
UNAVAILABLE = "Local subjects database is unavailable."
DUPLICATE = "A subject with this name already exists."
# A school has a few dozen subjects; the list is returned whole, so it is kept to a sensible size.
MAX_SUBJECTS = 300


def name_key(name: str) -> str:
    """How subject names are compared: letter case and extra spaces do not matter."""
    return " ".join(name.split()).casefold()


def names_of(record: SubjectRecord) -> dict[str, str]:
    names = {language: getattr(record, f"name_{language}") for language in LANGUAGES}
    names = {language: text for language, text in names.items() if text}
    # A subject saved before names were kept per language has only its main name.
    return names or {"uz": record.name}


async def subject_names(db: AsyncSession) -> dict[str, str]:
    """Each subject's main name, looked up by the comparison key of any of its names in any language."""
    lookup: dict[str, str] = {}
    for record in (await db.scalars(select(SubjectRecord))).all():
        for text in [record.name, *names_of(record).values()]:
            lookup.setdefault(name_key(text), record.name)
    return lookup


async def subject_translations(db: AsyncSession, name: str) -> dict[str, str]:
    """The names in each language of the subject with this main name, or nothing when it is not in the list."""
    record = await db.scalar(select(SubjectRecord).where(SubjectRecord.name == name))
    return names_of(record) if record else {}


def view(record: SubjectRecord, teachers: int) -> dict:
    return {"id": record.id, "name": record.name, "names": names_of(record), "grades": record.grades, "teachers": teachers, "created_at": record.created_at, "updated_at": record.updated_at}


async def teacher_count(db: AsyncSession, name: str) -> int:
    return await db.scalar(select(func.count()).select_from(TeacherRecord).where(TeacherRecord.subject == name))


async def refuse_taken_names(db: AsyncSession, payload: SubjectIn, own_id: str | None):
    """No name in any language may belong to another subject, in any language."""
    wanted = {name_key(text) for text in payload.names.values()}
    for record in (await db.scalars(select(SubjectRecord).where(SubjectRecord.id != (own_id or "")))).all():
        if wanted & {name_key(text) for text in [record.name, *names_of(record).values()]}:
            raise HTTPException(409, DUPLICATE)


def apply(record: SubjectRecord, payload: SubjectIn):
    record.name, record.name_key, record.grades = payload.name, name_key(payload.name), payload.grades
    for language in LANGUAGES:
        setattr(record, f"name_{language}", payload.names.get(language))


@router.get("", response_model=list[SubjectOut])
async def subjects(admin: Admin, db: Db):
    try:
        records = (await db.scalars(select(SubjectRecord).order_by(SubjectRecord.name_key, SubjectRecord.id))).all()
        counts = dict((await db.execute(select(TeacherRecord.subject, func.count()).group_by(TeacherRecord.subject))).all())
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    return [view(record, counts.get(record.name, 0)) for record in records]


@router.post("", response_model=SubjectOut, status_code=201)
async def create_subject(payload: SubjectIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    record = SubjectRecord()
    apply(record, payload)
    try:
        if len((await db.scalars(select(SubjectRecord.id).limit(MAX_SUBJECTS))).all()) >= MAX_SUBJECTS:
            raise HTTPException(400, "too_many_subjects")
        await refuse_taken_names(db, payload, None)
        db.add(record)
        await db.commit()
        # Teachers added before the subject list existed may already carry this exact name.
        return view(record, await teacher_count(db, record.name))
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, DUPLICATE)
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)


@router.put("/{subject_id}", response_model=SubjectOut)
async def update_subject(subject_id: UUID, payload: SubjectIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        record = await db.get(SubjectRecord, str(subject_id))
        if record is None:
            raise HTTPException(404, "Subject not found.")
        await refuse_taken_names(db, payload, record.id)
        if payload.name != record.name:
            # The subject's teachers follow it to its new main name.
            await db.execute(update(TeacherRecord).where(TeacherRecord.subject == record.name).values(subject=payload.name))
        apply(record, payload)
        record.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return view(record, await teacher_count(db, record.name))
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, DUPLICATE)
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)


@router.delete("/{subject_id}", status_code=204)
async def delete_subject(subject_id: UUID, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        record = await db.get(SubjectRecord, str(subject_id))
        # Repeated requests are safe.
        if record is None:
            return
        if await teacher_count(db, record.name):
            raise HTTPException(409, "in_use")
        await db.delete(record)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
