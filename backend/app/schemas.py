from datetime import date, datetime
from typing import Literal
from uuid import UUID
import re

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

StageName = Literal["Primary school", "Secondary school", "Not sure yet"]


class EnquiryIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr = Field(max_length=200)
    phone: str = Field(min_length=7, max_length=32)
    # Retained for older clients; new forms only ask for a grade.
    stage: StageName = "Not sure yet"
    grade: int = Field(ge=1, le=11, strict=True)
    message: str = Field(default="", max_length=3000)
    consent: Literal[True]

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        if not re.fullmatch(r"\+?[0-9 ().-]+", value):
            raise ValueError("Enter a valid phone number.")
        digits = re.sub(r"[^0-9]", "", value)
        if not 7 <= len(digits) <= 15:
            raise ValueError("Use 7 to 15 digits.")
        return re.sub(r"[ ().-]", "", value)


DEFAULT_NOTICE_CATEGORIES = ("News", "Admission guide")


class NoticeIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    category: str = Field(min_length=2, max_length=40)
    title: str = Field(min_length=3, max_length=160)
    body: str = Field(min_length=1, max_length=5000)
    published: bool = True
    pinned: bool = False

    @field_validator("category")
    @classmethod
    def tidy_category(cls, value: str) -> str:
        # One line, single spaces: categories are short labels shown as filter buttons.
        return " ".join(value.split())


class NoticePin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pinned: bool


class PublicNotice(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    category: str
    title: str
    body: str
    pinned: bool
    published_at: datetime


class AdminNotice(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    category: str
    title: str
    body: str
    published: bool
    pinned: bool
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime


class Receipt(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    reference: str
    status: Literal["received", "ready_for_review"]
    created_at: datetime


def normalise_phone(value: str) -> str:
    if not re.fullmatch(r"\+?[0-9 ().-]+", value):
        raise ValueError("Enter a valid phone number.")
    digits = re.sub(r"[^0-9]", "", value)
    if not 7 <= len(digits) <= 15:
        raise ValueError("Use 7 to 15 digits.")
    return re.sub(r"[ ().-]", "", value)


class StudentIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    full_name: str = Field(min_length=2, max_length=120)
    grade: int = Field(ge=1, le=11, strict=True)
    class_name: str | None = Field(default=None, max_length=10)
    birth_date: date | None = None
    parent_name: str | None = Field(default=None, max_length=120)
    parent_phone: str | None = Field(default=None, max_length=32)

    @field_validator("class_name", "parent_name", "parent_phone")
    @classmethod
    def empty_is_missing(cls, value: str | None) -> str | None:
        return value or None

    @field_validator("parent_phone")
    @classmethod
    def validate_phone(cls, value: str | None) -> str | None:
        return normalise_phone(value) if value else None

    @field_validator("birth_date")
    @classmethod
    def plausible_birth_date(cls, value: date | None) -> date | None:
        if value is not None and not date(1990, 1, 1) <= value <= date.today():
            raise ValueError("Enter a realistic date of birth.")
        return value


class StudentOut(StudentIn):
    model_config = ConfigDict(from_attributes=True, extra="ignore")
    id: UUID
    created_at: datetime
    updated_at: datetime


class StudentPage(BaseModel):
    items: list[StudentOut]
    total: int
    page: int
    page_size: int
    all_students: int


class ImportProblem(BaseModel):
    row: int
    name: str | None = None
    reason: Literal["missing_name", "bad_grade", "bad_date", "bad_phone", "bad_value"]


class StudentImportResult(BaseModel):
    rows: int
    added: int
    duplicates: int
    problems: list[ImportProblem]
    problem_count: int
    preview: list[StudentIn]
    saved: bool
