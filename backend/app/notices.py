"""School notices: a public list of published items and protected admin management."""
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import AdminSession, check_origin, private_response, require_admin
from .db import NoticeRecord, get_session
from .schemas import DEFAULT_NOTICE_CATEGORIES, AdminNotice, NoticeIn, NoticePin, PublicNotice

public_router = APIRouter(prefix="/api/notices", tags=["Notices"])
admin_router = APIRouter(prefix="/api/admin/notices", tags=["Local admin"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[AdminSession, Depends(require_admin)]
UNAVAILABLE = "Local notices database is unavailable."


async def existing_category(db: AsyncSession, name: str) -> str:
    """Reuses the spelling of a category that already exists, so "news" and "News" stay one category."""
    for default in DEFAULT_NOTICE_CATEGORIES:
        if default.casefold() == name.casefold():
            return default
    return await db.scalar(select(NoticeRecord.category).where(func.lower(NoticeRecord.category) == name.lower()).limit(1)) or name


@public_router.get("", response_model=list[PublicNotice])
async def published_notices(db: Db):
    try:
        # Drafts never leave the admin API.
        return (await db.scalars(select(NoticeRecord).where(NoticeRecord.published_at.is_not(None)).order_by(NoticeRecord.pinned.desc(), NoticeRecord.published_at.desc(), NoticeRecord.id).limit(50))).all()
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)


@admin_router.get("", response_model=list[AdminNotice])
async def all_notices(admin: Admin, db: Db):
    try:
        return (await db.scalars(select(NoticeRecord).order_by(NoticeRecord.pinned.desc(), NoticeRecord.created_at.desc(), NoticeRecord.id).limit(200))).all()
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)


@admin_router.post("", response_model=AdminNotice, status_code=201)
async def create_notice(payload: NoticeIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        record = NoticeRecord(category=await existing_category(db, payload.category), title=payload.title, body=payload.body, pinned=payload.pinned, published_at=datetime.now(timezone.utc) if payload.published else None)
        db.add(record)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return record


@admin_router.put("/{notice_id}", response_model=AdminNotice)
async def update_notice(notice_id: UUID, payload: NoticeIn, request: Request, admin: Admin, db: Db):
    check_origin(request)
    try:
        record = await db.get(NoticeRecord, str(notice_id))
        if record is None:
            raise HTTPException(404, "Notice not found.")
        record.category, record.title, record.body, record.pinned = await existing_category(db, payload.category), payload.title, payload.body, payload.pinned
        # Editing keeps the original publication time; republishing a draft starts a new one.
        if not payload.published:
            record.published_at = None
        elif record.published_at is None:
            record.published_at = datetime.now(timezone.utc)
        record.updated_at = datetime.now(timezone.utc)
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return record


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
    except SQLAlchemyError:
        await db.rollback()
        raise HTTPException(503, UNAVAILABLE)
    return record


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
