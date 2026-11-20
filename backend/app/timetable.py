"""Weekly timetables for admins: for each class, a lesson (a teacher and their subject) per day and period.

The week is Monday to Saturday, with seven one-hour periods from 08:00 to 15:00. A class has at most one
lesson at a time, a teacher teaches in one class at a time, and a lesson's subject must be one that the
class's grade takes.
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import and_, delete, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import AdminSession, check_origin, private_response, require_admin
from .db import LessonRecord, StudentRecord, SubjectRecord, TeacherRecord, get_session
from .schemas import ClassRef, ClassSummary, LessonIn, LessonOut, TimetableOut
from .subjects import names_of

router = APIRouter(prefix="/api/admin/timetable", tags=["Local admin"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[AdminSession, Depends(require_admin)]
UNAVAILABLE = "Local timetable database is unavailable."


def class_ref(grade: int = Query(ge=1, le=11), class_name: str = Query(default="", max_length=10)) -> ClassRef:
    try:
        return ClassRef(grade=grade, class_name=class_name)
    except ValueError:
        raise HTTPException(422, "bad_class")


Class = Annotated[ClassRef, Depends(class_ref)]


def in_class(ref: ClassRef):
    return and_(LessonRecord.grade == ref.grade, LessonRecord.class_name == ref.class_name)


async def subjects_by_name(db: AsyncSession) -> dict[str, SubjectRecord]:
    return {record.name: record for record in (await db.scalars(select(SubjectRecord))).all()}


def lesson_view(lesson: LessonRecord, teacher: TeacherRecord, subjects: dict[str, SubjectRecord]) -> dict:
    subject = subjects.get(teacher.subject)
    return {"id": lesson.id, "day": lesson.day, "period": lesson.period, "teacher_id": teacher.id, "teacher_name": teacher.full_name,
            "subject": teacher.subject, "subject_names": names_of(subject) if subject else {}}


@router.get("/classes", response_model=list[ClassSummary])
async def classes(admin: Admin, db: Db):
    """Every class that has students or lessons, in grade and letter order."""
    letter = func.upper(func.coalesce(StudentRecord.class_name, ""))
    try:
        students = (await db.execute(select(StudentRecord.grade, letter, func.count()).group_by(StudentRecord.grade, letter))).all()
        lessons = (await db.execute(select(LessonRecord.grade, LessonRecord.class_name, func.count()).group_by(LessonRecord.grade, LessonRecord.class_name))).all()
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    found: dict[tuple[int, str], dict] = {}
    for grade, name, count in students:
        found.setdefault((grade, name), {"grade": grade, "class_name": name, "students": 0, "lessons": 0})["students"] = count
    for grade, name, count in lessons:
        found.setdefault((grade, name), {"grade": grade, "class_name": name, "students": 0, "lessons": 0})["lessons"] = count
    return [found[key] for key in sorted(found)]


@router.get("", response_model=TimetableOut)
async def timetable(ref: Class, admin: Admin, db: Db):
    """A class's lessons, the times its possible teachers are busy elsewhere, and the lessons it can be given."""
    try:
        subjects = await subjects_by_name(db)
        rows = (await db.execute(select(LessonRecord, TeacherRecord).join(TeacherRecord, LessonRecord.teacher_id == TeacherRecord.id).where(in_class(ref)).order_by(LessonRecord.day, LessonRecord.period))).all()
        # Only the subjects this grade takes can be taught to the class.
        taught = {name for name, subject in subjects.items() if ref.grade in subject.grades}
        teachers = (await db.scalars(select(TeacherRecord).where(TeacherRecord.subject.in_(taught)).order_by(TeacherRecord.full_name, TeacherRecord.id))).all() if taught else []
        ids = [teacher.id for teacher in teachers] + [teacher.id for _, teacher in rows]
        busy = (await db.scalars(select(LessonRecord).where(LessonRecord.teacher_id.in_(ids), ~in_class(ref)))).all() if ids else []
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    options = sorted(({"teacher_id": teacher.id, "teacher_name": teacher.full_name, "subject": teacher.subject, "subject_names": names_of(subjects[teacher.subject])} for teacher in teachers), key=lambda option: (option["subject"].casefold(), option["teacher_name"].casefold()))
    return {
        "grade": ref.grade, "class_name": ref.class_name,
        "lessons": [lesson_view(lesson, teacher, subjects) for lesson, teacher in rows],
        "busy": [{"teacher_id": lesson.teacher_id, "day": lesson.day, "period": lesson.period, "grade": lesson.grade, "class_name": lesson.class_name} for lesson in busy],
        "options": options,
    }


@router.post("/lessons", response_model=LessonOut, status_code=201)
async def add_lesson(payload: LessonIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        teacher = await db.get(TeacherRecord, str(payload.teacher_id))
        if teacher is None:
            raise HTTPException(404, "teacher_not_found")
        subjects = await subjects_by_name(db)
        subject = subjects.get(teacher.subject)
        if subject is None or payload.grade not in subject.grades:
            raise HTTPException(422, "subject_not_for_grade")
        if await db.scalar(select(LessonRecord.id).where(in_class(payload), LessonRecord.day == payload.day, LessonRecord.period == payload.period)):
            raise HTTPException(409, "time_taken")
        if await db.scalar(select(LessonRecord.id).where(LessonRecord.teacher_id == teacher.id, LessonRecord.day == payload.day, LessonRecord.period == payload.period)):
            raise HTTPException(409, "teacher_busy")
        lesson = LessonRecord(grade=payload.grade, class_name=payload.class_name, day=payload.day, period=payload.period, teacher_id=teacher.id)
        db.add(lesson)
        await db.commit()
    except IntegrityError:
        # Someone else filled the time a moment earlier.
        await db.rollback()
        raise HTTPException(409, "time_taken")
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return lesson_view(lesson, teacher, subjects)


@router.delete("/lessons/{lesson_id}", status_code=204)
async def remove_lesson(lesson_id: UUID, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        # Repeated requests are safe.
        await db.execute(delete(LessonRecord).where(LessonRecord.id == str(lesson_id)))
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
