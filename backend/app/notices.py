"""School notices: a public list of published items in the visitor's language, and protected admin management.

A notice can be written in Uzbek, English, and Russian. Visitors get the version in their own language;
when that version is missing, the next language in FALLBACK is used so nobody sees an empty notice.
"""
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import AdminSession, check_origin, private_response, require_admin
from .db import NoticeCategoryRecord, NoticeRecord, get_session
from .schemas import DEFAULT_NOTICE_CATEGORIES, LANGUAGES, AdminNotice, NoticeIn, NoticePin, PublicNotice

public_router = APIRouter(prefix="/api/notices", tags=["Notices"])
admin_router = APIRouter(prefix="/api/admin/notices", tags=["Local admin"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[AdminSession, Depends(require_admin)]
UNAVAILABLE = "Local notices database is unavailable."
# Which languages to try, in order, for a visitor reading in each language.
FALLBACK = {"uz": ("uz", "ru", "en"), "ru": ("ru", "uz", "en"), "en": ("en", "uz", "ru")}


def translations(record: NoticeRecord) -> dict[str, dict[str, str]]:
    """The languages a notice has been written in."""
    return {language: {"title": title, "body": getattr(record, f"body_{language}") or ""} for language in LANGUAGES if (title := getattr(record, f"title_{language}"))}


def category_labels(category: NoticeCategoryRecord | None) -> dict[str, str]:
    return {language: label for language in LANGUAGES if category and (label := getattr(category, f"label_{language}"))}


def admin_view(record: NoticeRecord, categories: dict[str, NoticeCategoryRecord]) -> dict:
    return {
        "id": record.id, "category": record.category, "category_labels": category_labels(categories.get(record.category)), "title": record.title,
        "translations": translations(record), "published": record.published, "pinned": record.pinned,
        "published_at": record.published_at, "created_at": record.created_at, "updated_at": record.updated_at,
    }


async def all_categories(db: AsyncSession) -> dict[str, NoticeCategoryRecord]:
    return {category.name: category for category in (await db.scalars(select(NoticeCategoryRecord))).all()}


async def existing_category(db: AsyncSession, name: str) -> str:
    """Reuses the spelling of a category that already exists, so "news" and "News" stay one category."""
    for default in DEFAULT_NOTICE_CATEGORIES:
        if default.casefold() == name.casefold():
            return default
    return await db.scalar(select(NoticeRecord.category).where(func.lower(NoticeRecord.category) == name.lower()).limit(1)) or name


async def apply(db: AsyncSession, record: NoticeRecord, payload: NoticeIn):
    """Copies an admin's input onto a notice and saves the category's names in each language."""
    record.category = await existing_category(db, payload.category)
    record.pinned = payload.pinned
    for language in LANGUAGES:
        text = payload.translations.get(language)
        setattr(record, f"title_{language}", text.title if text else None)
        setattr(record, f"body_{language}", text.body if text else None)
    # The primary text (shown in the admin list) is the first language written, Uzbek first.
    primary = next(payload.translations[language] for language in LANGUAGES if language in payload.translations)
    record.title, record.body = primary.title, primary.body
    # The two built-in categories are translated by the website itself; only admin-created ones store names.
    if payload.category_labels is not None and record.category not in DEFAULT_NOTICE_CATEGORIES:
        category = await db.get(NoticeCategoryRecord, record.category)
        if category is None:
            category = NoticeCategoryRecord(name=record.category)
            db.add(category)
        for language in LANGUAGES:
            setattr(category, f"label_{language}", payload.category_labels.get(language) or None)


@public_router.get("", response_model=list[PublicNotice])
async def published_notices(db: Db, lang: Literal["uz", "en", "ru"] = "uz"):
    try:
        # Drafts never leave the admin API.
        records = (await db.scalars(select(NoticeRecord).where(NoticeRecord.published_at.is_not(None)).order_by(NoticeRecord.pinned.desc(), NoticeRecord.published_at.desc(), NoticeRecord.id).limit(50))).all()
        categories = await all_categories(db)
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    notices = []
    for record in records:
        written = translations(record)
        shown = next((language for language in FALLBACK[lang] if language in written), None)
        if shown is None:
            continue
        labels = category_labels(categories.get(record.category))
        notices.append({
            "id": record.id, "category": record.category, "category_label": next((labels[language] for language in FALLBACK[lang] if language in labels), None),
            "title": written[shown]["title"], "body": written[shown]["body"], "lang": shown, "pinned": record.pinned, "published_at": record.published_at,
        })
    return notices


@admin_router.get("", response_model=list[AdminNotice])
async def all_notices(admin: Admin, db: Db):
    try:
        records = (await db.scalars(select(NoticeRecord).order_by(NoticeRecord.pinned.desc(), NoticeRecord.created_at.desc(), NoticeRecord.id).limit(200))).all()
        categories = await all_categories(db)
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    return [admin_view(record, categories) for record in records]


@admin_router.post("", response_model=AdminNotice, status_code=201)
async def create_notice(payload: NoticeIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        record = NoticeRecord(published_at=datetime.now(timezone.utc) if payload.published else None)
        await apply(db, record, payload)
        db.add(record)
        await db.commit()
        return admin_view(record, await all_categories(db))
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)


@admin_router.put("/{notice_id}", response_model=AdminNotice)
async def update_notice(notice_id: UUID, payload: NoticeIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        record = await db.get(NoticeRecord, str(notice_id))
        if record is None:
            raise HTTPException(404, "Notice not found.")
        await apply(db, record, payload)
        # Editing keeps the original publication time; republishing a draft starts a new one.
        if not payload.published:
            record.published_at = None
        elif record.published_at is None:
            record.published_at = datetime.now(timezone.utc)
        record.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return admin_view(record, await all_categories(db))
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)


@admin_router.patch("/{notice_id}/pinned", response_model=AdminNotice)
async def pin_notice(notice_id: UUID, payload: NoticePin, request: Request, admin: Admin, db: Db):
    """Pins or unpins one notice from the list without touching its text or publication time."""
    check_origin(request)
    try:
        record = await db.get(NoticeRecord, str(notice_id))
        if record is None:
            raise HTTPException(404, "Notice not found.")
        record.pinned = payload.pinned
        await db.commit()
        return admin_view(record, await all_categories(db))
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)


@admin_router.delete("/{notice_id}", status_code=204)
async def delete_notice(notice_id: UUID, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        # Repeated requests are safe.
        await db.execute(delete(NoticeRecord).where(NoticeRecord.id == str(notice_id)))
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
