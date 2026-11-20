from datetime import date, datetime, timezone
from uuid import uuid4

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Identity, Integer, String, Text, UniqueConstraint, false
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .config import settings
from .pass_keys import new_pass_key

engine = create_async_engine(settings.database_url, pool_pre_ping=True, connect_args={"connect_timeout": 3})
Session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class EnquiryRecord(Base):
    __tablename__ = "enquiries"
    __table_args__ = (CheckConstraint("grade BETWEEN 1 AND 11", name="ck_enquiries_grade"), UniqueConstraint("reference_number", name="uq_enquiries_reference_number"))
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    reference_number: Mapped[int] = mapped_column(BigInteger, Identity())
    idempotency_key: Mapped[str] = mapped_column(String(36), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    stage: Mapped[str] = mapped_column(String(40))
    # Older enquiries have no grade recorded; all new API requests require one.
    grade: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(40), default="received")
    staff_received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dispatched: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    @property
    def reference(self) -> str:
        return f"BM-{self.reference_number:06d}"


class NoticeRecord(Base):
    __tablename__ = "notices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    # A label chosen or created by an admin, stored as written (for example "News").
    category: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text)
    # The same notice in each language it has been written in. `title` and `body` above hold the first of these.
    title_uz: Mapped[str | None] = mapped_column(String(160), nullable=True)
    body_uz: Mapped[str | None] = mapped_column(Text, nullable=True)
    title_en: Mapped[str | None] = mapped_column(String(160), nullable=True)
    body_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    title_ru: Mapped[str | None] = mapped_column(String(160), nullable=True)
    body_ru: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Drafts have no publication time; only published notices are public.
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    # Pinned notices are listed first and highlighted on the website.
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    @property
    def published(self) -> bool:
        return self.published_at is not None


class NoticeCategoryRecord(Base):
    """Names of an admin-created notice category in each language. `name` matches NoticeRecord.category."""
    __tablename__ = "notice_categories"
    name: Mapped[str] = mapped_column(String(40), primary_key=True)
    label_uz: Mapped[str | None] = mapped_column(String(40), nullable=True)
    label_en: Mapped[str | None] = mapped_column(String(40), nullable=True)
    label_ru: Mapped[str | None] = mapped_column(String(40), nullable=True)


class StudentRecord(Base):
    __tablename__ = "students"
    __table_args__ = (CheckConstraint("grade BETWEEN 1 AND 11", name="ck_students_grade"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    full_name: Mapped[str] = mapped_column(String(120), index=True)
    grade: Mapped[int] = mapped_column(Integer, index=True)
    # The class within a grade, such as "A"; optional.
    class_name: Mapped[str | None] = mapped_column(String(10), nullable=True)
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    parent_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    parent_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Generated for every student; a parent uses it to sign up. Admins can read it in the student list at any time.
    pass_key: Mapped[str] = mapped_column(String(14), unique=True, default=new_pass_key)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class TeacherRecord(Base):
    __tablename__ = "teachers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    full_name: Mapped[str] = mapped_column(String(120), index=True)
    subject: Mapped[str] = mapped_column(String(80))
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Generated sign-in for the teacher pages. Only a salted scrypt hash of the password is kept.
    login: Mapped[str] = mapped_column(String(40), unique=True)
    password_salt: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class SubjectRecord(Base):
    __tablename__ = "subjects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    # The main name: the Uzbek name, or the English or Russian one when there is no Uzbek name.
    # Teachers' records hold this name.
    name: Mapped[str] = mapped_column(String(80))
    # The main name in lower case with single spaces; unique, so "Maths" and " maths " are the same subject.
    name_key: Mapped[str] = mapped_column(String(80), unique=True)
    # The name in each language; any of them may be missing.
    name_uz: Mapped[str | None] = mapped_column(String(80), nullable=True)
    name_en: Mapped[str | None] = mapped_column(String(80), nullable=True)
    name_ru: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # The grades (1-11) that take the subject, in ascending order. Empty until an admin assigns some.
    grades: Mapped[list[int]] = mapped_column(ARRAY(Integer), default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class LessonRecord(Base):
    """One lesson in a class's weekly timetable: a teacher (and so their subject) at a day and period."""
    __tablename__ = "lessons"
    __table_args__ = (
        CheckConstraint("grade BETWEEN 1 AND 11", name="ck_lessons_grade"),
        CheckConstraint("day BETWEEN 0 AND 5", name="ck_lessons_day"),
        CheckConstraint("period BETWEEN 0 AND 6", name="ck_lessons_period"),
        # One lesson per class at a time, and a teacher in one place at a time.
        UniqueConstraint("grade", "class_name", "day", "period", name="uq_lessons_class_time"),
        UniqueConstraint("teacher_id", "day", "period", name="uq_lessons_teacher_time"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    grade: Mapped[int] = mapped_column(Integer)
    # The class letter in capitals, such as "A"; empty for a grade with a single class.
    class_name: Mapped[str] = mapped_column(String(10), default="")
    # 0 is Monday ... 5 is Saturday; period 0 starts at 08:00, period 6 at 14:00.
    day: Mapped[int] = mapped_column(Integer)
    period: Mapped[int] = mapped_column(Integer)
    # Removing a teacher removes their lessons.
    teacher_id: Mapped[str] = mapped_column(String(36), ForeignKey("teachers.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


async def get_session():
    async with Session() as session:
        yield session
