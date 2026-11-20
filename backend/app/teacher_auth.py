"""Teacher sign-in with the login and password generated in the admin panel.

Teachers never sign up: an admin adds them and hands over the generated details. Sessions are kept on the
server and tied to the password that opened them, so generating a new password for a teacher (or removing
the teacher) signs them out.
"""
import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass
import hashlib
import secrets
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .admin_auth import check_origin, hash_password, private_response
from .db import TeacherRecord, get_session
from .schemas import TeacherIdentity, TeacherLoginIn

router = APIRouter(prefix="/api/teacher", tags=["Teachers"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
COOKIE = "bm_teacher_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
MAX_SESSIONS = 1000
# Wrong attempts allowed per minute, counted both for the address they come from and for the login they target.
MAX_ATTEMPTS = 5
UNAVAILABLE = "Teacher sign-in is unavailable."
SIGN_IN_REQUIRED = "Teacher sign-in required."
# Checked when the login does not exist, so an unknown login takes as long to refuse as a wrong password.
DUMMY_SALT = secrets.token_bytes(16)


@dataclass
class TeacherSession:
    teacher_id: str
    password_hash: str
    expires: float


sessions: dict[str, TeacherSession] = {}
attempts: dict[str, deque] = defaultdict(deque)


def session_key(request: Request) -> str:
    return hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest()


def recent_attempts(key: str, now: float) -> deque:
    recent = attempts[key]
    while recent and recent[0] <= now - 60:
        recent.popleft()
    return recent


async def current_teacher(request: Request, db: Db) -> TeacherRecord:
    """The signed-in teacher; the session ends if their password has been replaced or they were removed."""
    key = session_key(request)
    session = sessions.get(key)
    if session is None or session.expires <= time.time():
        sessions.pop(key, None)
        raise HTTPException(401, SIGN_IN_REQUIRED)
    try:
        teacher = await db.get(TeacherRecord, session.teacher_id)
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    if teacher is None or not secrets.compare_digest(teacher.password_hash, session.password_hash):
        sessions.pop(key, None)
        raise HTTPException(401, SIGN_IN_REQUIRED)
    return teacher


Teacher = Annotated[TeacherRecord, Depends(current_teacher)]


@router.post("/login", response_model=TeacherIdentity)
async def login(payload: TeacherLoginIn, request: Request, response: Response, db: Db):
    check_origin(request)
    login_name = payload.login.strip().lower()
    now = time.monotonic()
    limits = [recent_attempts(f"address:{request.client.host if request.client else 'local'}", now), recent_attempts(f"login:{login_name}", now)]
    if any(len(recent) >= MAX_ATTEMPTS for recent in limits):
        raise HTTPException(429, "Too many sign-in attempts. Try again in a minute.")
    try:
        teacher = await db.scalar(select(TeacherRecord).where(TeacherRecord.login == login_name))
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    salt = bytes.fromhex(teacher.password_salt) if teacher else DUMMY_SALT
    # The password hash is slow on purpose; keep the server responsive while it is computed.
    digest = await asyncio.to_thread(hash_password, payload.password, salt)
    if teacher is None or not secrets.compare_digest(digest, teacher.password_hash):
        for recent in limits:
            recent.append(now)
        raise HTTPException(401, "Incorrect login or password.")
    limits[1].clear()
    for key, session in list(sessions.items()):
        if session.expires <= time.time():
            sessions.pop(key, None)
    if len(sessions) >= MAX_SESSIONS:
        sessions.pop(next(iter(sessions)))
    token = secrets.token_urlsafe(32)
    sessions[hashlib.sha256(token.encode()).hexdigest()] = TeacherSession(teacher.id, teacher.password_hash, time.time() + SESSION_SECONDS)
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", secure=False, path="/api/teacher", max_age=SESSION_SECONDS)
    return teacher


@router.get("/session", response_model=TeacherIdentity)
async def session(teacher: Teacher):
    return teacher


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response):
    check_origin(request)
    sessions.pop(session_key(request), None)
    response.delete_cookie(COOKIE, path="/api/teacher", httponly=True, samesite="strict")
