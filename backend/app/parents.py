"""Parent sign-in with a student's pass key, and what a signed-in parent can see.

A parent enters only the pass key the school gave them. Sessions are kept on the server and tied to the
key that opened them, so generating a new key for a student (or removing the student) signs the parent out.
"""
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

from .admin_auth import check_origin, private_response
from .db import StudentRecord, get_session
from .pass_keys import normalise_pass_key
from .schemas import ParentChild, ParentLoginIn

router = APIRouter(prefix="/api/parent", tags=["Parents"], dependencies=[Depends(private_response)])
Db = Annotated[AsyncSession, Depends(get_session)]
COOKIE = "bm_parent_session"
SESSION_SECONDS = 30 * 24 * 60 * 60
MAX_SESSIONS = 5000
# Wrong keys allowed from one address per minute. A key has about 10^17 possibilities, so guessing is hopeless
# anyway; the limit keeps it from being tried.
MAX_ATTEMPTS = 8
UNAVAILABLE = "Parent sign-in is unavailable."
SIGN_IN_REQUIRED = "Parent sign-in required."


@dataclass
class ParentSession:
    student_id: str
    pass_key: str
    expires: float


sessions: dict[str, ParentSession] = {}
attempts: dict[str, deque] = defaultdict(deque)


def session_key(request: Request) -> str:
    return hashlib.sha256(request.cookies.get(COOKIE, "").encode()).hexdigest()


async def current_child(request: Request, db: Db) -> StudentRecord:
    """The student whose pass key opened this session; the session ends if that key no longer belongs to them."""
    key = session_key(request)
    session = sessions.get(key)
    if session is None or session.expires <= time.time():
        sessions.pop(key, None)
        raise HTTPException(401, SIGN_IN_REQUIRED)
    try:
        student = await db.get(StudentRecord, session.student_id)
    except SQLAlchemyError:
        raise HTTPException(503, UNAVAILABLE)
    if student is None or not secrets.compare_digest(student.pass_key, session.pass_key):
        sessions.pop(key, None)
        raise HTTPException(401, SIGN_IN_REQUIRED)
    return student


Child = Annotated[StudentRecord, Depends(current_child)]


@router.post("/login", response_model=ParentChild)
async def login(payload: ParentLoginIn, request: Request, response: Response, db: Db):
    check_origin(request)
    address = request.client.host if request.client else "local"
    now = time.monotonic()
    recent = attempts[address]
    while recent and recent[0] <= now - 60:
        recent.popleft()
    if len(recent) >= MAX_ATTEMPTS:
        raise HTTPException(429, "Too many sign-in attempts. Try again in a minute.")
    pass_key = normalise_pass_key(payload.pass_key)
    student = None
    if pass_key:
        try:
            student = await db.scalar(select(StudentRecord).where(StudentRecord.pass_key == pass_key))
        except SQLAlchemyError:
            raise HTTPException(503, UNAVAILABLE)
    if student is None:
        recent.append(now)
        raise HTTPException(401, "Incorrect pass key.")
    for key, session in list(sessions.items()):
        if session.expires <= time.time():
            sessions.pop(key, None)
    if len(sessions) >= MAX_SESSIONS:
        sessions.pop(next(iter(sessions)))
    token = secrets.token_urlsafe(32)
    sessions[hashlib.sha256(token.encode()).hexdigest()] = ParentSession(student.id, student.pass_key, time.time() + SESSION_SECONDS)
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", secure=False, path="/api/parent", max_age=SESSION_SECONDS)
    return student


@router.get("/session", response_model=ParentChild)
async def session(child: Child):
    return child


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response):
    check_origin(request)
    sessions.pop(session_key(request), None)
    response.delete_cookie(COOKIE, path="/api/parent", httponly=True, samesite="strict")
