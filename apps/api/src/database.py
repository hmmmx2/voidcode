"""
Database configuration — async SQLAlchemy 2.0 + asyncpg.

Usage in FastAPI endpoints:
    from .database import get_db

    @router.get("/problems")
    async def list_problems(db: AsyncSession = Depends(get_db)):
        ...
"""

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

# Connection URL from environment — defaults to local dev
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://alwin:alwin_dev@localhost:5433/alwin_tutor",
)

# Async engine — pool size tuned for a single-server deployment
engine = create_async_engine(
    DATABASE_URL,
    echo=False,  # Set True for SQL logging during development
    pool_size=5,  # Keep small — GPU server has limited resources
    max_overflow=10,
    pool_pre_ping=True,  # Detect stale connections
)

# Session factory — expire_on_commit=False so objects remain usable after commit
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Declarative base for all SQLAlchemy models."""

    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
