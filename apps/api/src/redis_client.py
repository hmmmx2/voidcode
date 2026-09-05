"""
Async Redis client for session caching and future rate limiting.

Uses redis-py>=5.0 which includes native async support.
"""

import logging
import os

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6380/0")

# Global client — initialized at startup, closed at shutdown
_redis: aioredis.Redis | None = None


async def init_redis() -> aioredis.Redis:
    """Create and test the Redis connection."""
    global _redis
    _redis = aioredis.from_url(
        REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        max_connections=10,
    )
    # Verify connection
    await _redis.ping()
    logger.info(f"Redis connected: {REDIS_URL}")
    return _redis


async def close_redis() -> None:
    """Close the Redis connection pool."""
    global _redis
    if _redis:
        await _redis.close()
        _redis = None
        logger.info("Redis connection closed")


def get_redis() -> aioredis.Redis:
    """
    Get the Redis client. Use as a FastAPI dependency:

        @router.get("/...")
        async def endpoint(redis: aioredis.Redis = Depends(get_redis)):
            await redis.get("key")
    """
    if _redis is None:
        raise RuntimeError("Redis not initialized. Call init_redis() first.")
    return _redis
