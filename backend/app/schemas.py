from datetime import date, datetime
from typing import Annotated, Literal
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


# The website's languages; Uzbek first because it is the site's default.
LANGUAGES = ("uz", "en", "ru")
Language = Literal["uz", "en", "ru"]


class NoticeText(BaseModel):
    """A notice as written in one language."""
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    title: str = Field(min_length=3, max_length=160)
    body: str = Field(min_length=1, max_length=5000)


class NoticeIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    category: str = Field(min_length=2, max_length=40)
    # The notice in each language it has been written in; at least one is required.
    translations: dict[Language, NoticeText] = Field(min_length=1)
    # Names of an admin-created category in each language; omitted to leave them unchanged.
    category_labels: dict[Language, str] | None = None
    published: bool = True
    pinned: bool = False

    @field_validator("category")
    @classmethod
    def tidy_category(cls, value: str) -> str:
        # One line, single spaces: categories are short labels shown as filter buttons.
        return " ".join(value.split())

    @field_validator("category_labels")
    @classmethod
    def tidy_labels(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return None
        labels = {language: " ".join(label.split()) for language, label in value.items()}
        if any(len(label) > 40 for label in labels.values()):
            raise ValueError("Category names can be up to 40 characters.")
        return {language: label for language, label in labels.items() if label}


class NoticePin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pinned: bool


class PublicNotice(BaseModel):
    """A published notice in one language, chosen for the visitor."""
    id: UUID
    category: str
    # The category's name in the visitor's language, when an admin has provided one.
    category_label: str | None
    title: str
    body: str
    # The language the title and body are actually in, which may be a fallback.
    lang: Language
    pinned: bool
    published_at: datetime


class AdminNotice(BaseModel):
    id: UUID
    category: str
    category_labels: dict[Language, str]
    # The first language written, for lists.
    title: str
    translations: dict[Language, NoticeText]
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
    pass_key: str


class ParentLoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pass_key: str = Field(min_length=1, max_length=40)


class ParentChild(BaseModel):
    """What a signed-in parent sees about their child. Never includes the pass key or contact details."""
    model_config = ConfigDict(from_attributes=True)
    full_name: str
    grade: int
    class_name: str | None


class SubjectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # The subject's name in each language. At least one is needed; an empty name means "not written".
    names: dict[Language, Annotated[str, Field(max_length=80)]]
    grades: list[Annotated[int, Field(ge=1, le=11, strict=True)]] = Field(default_factory=list, max_length=11)

    @field_validator("names")
    @classmethod
    def tidy_names(cls, value: dict[str, str]) -> dict[str, str]:
        names = {language: " ".join(text.split()) for language, text in value.items()}
        names = {language: text for language, text in names.items() if text}
        if not names:
            raise ValueError("Enter the subject's name in at least one language.")
        if any(len(text) < 2 for text in names.values()):
            raise ValueError("Each name needs at least 2 characters.")
        return {language: names[language] for language in LANGUAGES if language in names}

    @property
    def name(self) -> str:
        """The main name: Uzbek first, then English, then Russian."""
        return next(self.names[language] for language in LANGUAGES if language in self.names)

    @field_validator("grades")
    @classmethod
    def distinct_in_order(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value):
            raise ValueError("Each grade can be chosen only once.")
        return sorted(value)


class SubjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    names: dict[Language, str]
    grades: list[int]
    # How many teachers teach this subject.
    teachers: int
    created_at: datetime
    updated_at: datetime


class TeacherLoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=1, max_length=128)


class TeacherIdentity(BaseModel):
    """What a signed-in teacher sees about their own account. Never includes the password or its hash."""
    model_config = ConfigDict(from_attributes=True)
    full_name: str
    subject: str
    # The subject's name in each language, when it is in the subject list.
    subject_names: dict[Language, str] = Field(default_factory=dict)
    login: str


class ImportedPassKey(BaseModel):
    full_name: str
    grade: int
    class_name: str | None
    pass_key: str


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
    pass_keys: list[ImportedPassKey]


class TeacherIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    full_name: str = Field(min_length=2, max_length=120)
    subject: str = Field(min_length=2, max_length=80)
    phone: str | None = Field(default=None, max_length=32)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str | None) -> str | None:
        return normalise_phone(value) if value else None


class TeacherOut(TeacherIn):
    """A teacher as admins see them: the login is included, the password hash never is."""
    model_config = ConfigDict(from_attributes=True, extra="ignore")
    id: UUID
    login: str
    created_at: datetime
    updated_at: datetime


class TeacherCredentials(BaseModel):
    """Returned once, when a password is generated."""
    teacher: TeacherOut
    password: str


class TeacherPage(BaseModel):
    items: list[TeacherOut]
    total: int
    page: int
    page_size: int


class TeacherImportProblem(BaseModel):
    row: int
    name: str | None = None
    reason: Literal["missing_name", "missing_subject", "unknown_subject", "bad_phone", "bad_value"]


class ImportedCredentials(BaseModel):
    full_name: str
    subject: str
    login: str
    password: str


class TeacherImportResult(BaseModel):
    rows: int
    added: int
    duplicates: int
    problems: list[TeacherImportProblem]
    problem_count: int
    preview: list[TeacherIn]
    saved: bool
    credentials: list[ImportedCredentials]
