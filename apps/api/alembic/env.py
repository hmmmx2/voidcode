"""
Alembic migration environment.

This file is configured to:
1. Import all SQLAlchemy models so autogenerate detects them
2. Read the database URL from environment or alembic.ini
3. Run migrations in both 'offline' and 'online' modes
"""

import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Add the project src directory to Python path so we can import models
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.database import Base

# Import all models so Base.metadata is populated for autogenerate.
#
# `Course`, `Module` and `ContentItem` were removed here along with the course
# hierarchy. A stale name in this list breaks EVERY alembic command — including
# the downgrade of the very revision that deleted the model — because env.py is
# imported before any migration runs, so the ImportError fires first.
from src.models import (  # noqa: F401
    ChatMessage,
    ChatSession,
    CodeDraft,
    CodeTemplate,
    Notification,
    Problem,
    Submission,
    TestCase,
    TestCaseResult,
    User,
    UserPreferences,
)

# Alembic Config object — access to values in alembic.ini
config = context.config

# Set up Python logging from alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# The metadata object for autogenerate support
target_metadata = Base.metadata

# Allow DATABASE_URL_SYNC env var to override alembic.ini
database_url = os.getenv("DATABASE_URL_SYNC")
if database_url:
    config.set_main_option("sqlalchemy.url", database_url)


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    Generates SQL script without connecting to the database.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    Creates an Engine and associates a connection with the context.
    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
