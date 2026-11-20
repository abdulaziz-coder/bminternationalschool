"""School subjects for admins: each subject has a name and the grades (1-11) that take it.

Teachers are given one of these subjects. A teacher's record holds the subject's name, so renaming a
subject renames it for its teachers too, and a subject that still has teachers cannot be removed.
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
from .schemas import SubjectIn, SubjectOut

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


async def subject_names(db: AsyncSession) -> dict[str, str]:
    """Every subject's name as the admin wrote it, looked up by its comparison key."""
    return {key: name for key, name in (await db.execute(select(SubjectRecord.name_key, SubjectRecord.name))).all()}


def view(record: SubjectRecord, teachers: int) -> dict:
    return {"id": record.id, "name": record.name, "grades": record.grades, "teachers": teachers, "created_at": record.created_at, "updated_at": record.updated_at}


async def teacher_count(db: AsyncSession, name: str) -> int:
    return await db.scalar(select(func.count()).select_from(TeacherRecord).where(TeacherRecord.subject == name))


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
    record = SubjectRecord(name=payload.name, name_key=name_key(payload.name), grades=payload.grades)
    try:
        if len((await db.scalars(select(SubjectRecord.id).limit(MAX_SUBJECTS))).all()) >= MAX_SUBJECTS:
            raise HTTPException(400, "too_many_subjects")
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
        if payload.name != record.name:
            # The subject's teachers follow it to its new name.
            await db.execute(update(TeacherRecord).where(TeacherRecord.subject == record.name).values(subject=payload.name))
        record.name, record.name_key, record.grades = payload.name, name_key(payload.name), payload.grades
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
