"""The signed-in teacher's pages: their weekly timetable, and each lesson's register of attendance and grades.

A teacher sees only their own lessons. A register belongs to one lesson on one date; that date must fall on
the lesson's weekday and cannot be in the future. Saving replaces the marks of the students it includes.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import check_origin, private_response
from .db import LessonRecord, MarkRecord, StudentRecord, SubjectRecord, TeacherRecord, get_session
from .schemas import Register, RegisterIn, TeacherWeek
from .subjects import names_of
from .teacher_auth import current_teacher

router = APIRouter(prefix="/api/teacher", tags=["Teachers"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
Teacher = Annotated[TeacherRecord, Depends(current_teacher)]
UNAVAILABLE = "Teacher pages are unavailable."


def today() -> date:
    """The school's date. The server runs at the school, so its local date is the school's."""
    return date.today()


def monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def class_students(grade: int, class_name: str):
    return select(StudentRecord).where(StudentRecord.grade == grade, func.upper(func.coalesce(StudentRecord.class_name, "")) == class_name)


async def subject_names(db: AsyncSession, name: str) -> dict:
    record = await db.scalar(select(SubjectRecord).where(SubjectRecord.name == name))
    return names_of(record) if record else {}


@router.get("/timetable", response_model=TeacherWeek)
async def week(teacher: Teacher, db: Db, start: date | None = Query(default=None, description="Any date in the week to show; this week by default.")):
    monday = monday_of(start or today())
    letter = func.upper(func.coalesce(StudentRecord.class_name, ""))
    try:
        lessons = (await db.scalars(select(LessonRecord).where(LessonRecord.teacher_id == teacher.id).order_by(LessonRecord.day, LessonRecord.period))).all()
        sizes = {(grade, name): count for grade, name, count in (await db.execute(select(StudentRecord.grade, letter, func.count()).group_by(StudentRecord.grade, letter))).all()}
        recorded = set((await db.execute(select(MarkRecord.date, MarkRecord.period).where(MarkRecord.teacher_id == teacher.id, MarkRecord.date.between(monday, monday + timedelta(days=5))).distinct())).all())
        names = await subject_names(db, teacher.subject)
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    return {"week_start": monday, "today": today(), "lessons": [{
        "id": lesson.id, "day": lesson.day, "period": lesson.period, "date": monday + timedelta(days=lesson.day),
        "grade": lesson.grade, "class_name": lesson.class_name, "subject": teacher.subject, "subject_names": names,
        "students": sizes.get((lesson.grade, lesson.class_name), 0), "recorded": (monday + timedelta(days=lesson.day), lesson.period) in recorded,
    } for lesson in lessons]}


async def teachers_lesson(db: AsyncSession, teacher: TeacherRecord, lesson_id: UUID, on: date) -> LessonRecord:
    lesson = await db.get(LessonRecord, str(lesson_id))
    # Another teacher's lesson is treated as missing.
    if lesson is None or lesson.teacher_id != teacher.id:
        raise HTTPException(404, "lesson_not_found")
    if on.weekday() != lesson.day:
        raise HTTPException(422, "wrong_day")
    return lesson


async def register_view(db: AsyncSession, teacher: TeacherRecord, lesson: LessonRecord, on: date) -> dict:
    students = (await db.scalars(class_students(lesson.grade, lesson.class_name).order_by(StudentRecord.full_name, StudentRecord.id))).all()
    marks = {mark.student_id: mark for mark in (await db.scalars(select(MarkRecord).where(MarkRecord.date == on, MarkRecord.period == lesson.period, MarkRecord.student_id.in_([student.id for student in students])))).all()} if students else {}
    return {
        "lesson_id": lesson.id, "date": on, "day": lesson.day, "period": lesson.period, "grade": lesson.grade, "class_name": lesson.class_name,
        "subject": teacher.subject, "subject_names": await subject_names(db, teacher.subject), "editable": on <= today(),
        "saved_at": max((mark.updated_at for mark in marks.values()), default=None),
        "students": [{"id": student.id, "full_name": student.full_name, "attendance": marks[student.id].attendance if student.id in marks else None,
                      "score": marks[student.id].score if student.id in marks else None} for student in students],
    }


@router.get("/lessons/{lesson_id}/register", response_model=Register)
async def register(lesson_id: UUID, teacher: Teacher, db: Db, on: date = Query(alias="date")):
    try:
        lesson = await teachers_lesson(db, teacher, lesson_id, on)
        return await register_view(db, teacher, lesson, on)
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)


@router.put("/lessons/{lesson_id}/register", response_model=Register)
async def save_register(lesson_id: UUID, payload: RegisterIn, request: Request, teacher: Teacher, db: Db, on: date = Query(alias="date")):
    check_origin(request)
    try:
        lesson = await teachers_lesson(db, teacher, lesson_id, on)
        if on > today():
            raise HTTPException(422, "future_date")
        ids = {str(mark.student_id) for mark in payload.marks}
        if len(ids) != len(payload.marks):
            raise HTTPException(422, "duplicate_student")
        in_class = set((await db.scalars(class_students(lesson.grade, lesson.class_name).with_only_columns(StudentRecord.id))).all())
        if not ids <= in_class:
            raise HTTPException(422, "unknown_student")
        if ids:
            await db.execute(delete(MarkRecord).where(MarkRecord.date == on, MarkRecord.period == lesson.period, MarkRecord.student_id.in_(ids)))
            now = datetime.now(timezone.utc)
            db.add_all([MarkRecord(student_id=str(mark.student_id), date=on, period=lesson.period, teacher_id=teacher.id, subject=teacher.subject,
                                   attendance=mark.attendance, score=mark.score, updated_at=now) for mark in payload.marks])
        await db.commit()
        return await register_view(db, teacher, lesson, on)
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
