"""add_modules_and_content_items

Revision ID: a7b2c3d4e5f6
Revises: 3ac4f79184db
Create Date: 2026-02-18 22:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'a7b2c3d4e5f6'
down_revision: str | None = '3ac4f79184db'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Define the enum using the PostgreSQL dialect (supports create_type=False)
content_item_type_enum = postgresql.ENUM(
    'tutorial_problem', 'quiz', 'exam',
    name='content_item_type_enum',
    create_type=False,
)


def upgrade() -> None:
    # Step 1: Create the PostgreSQL enum type via raw SQL
    op.execute("CREATE TYPE content_item_type_enum AS ENUM ('tutorial_problem', 'quiz', 'exam')")

    # Step 2: Create modules table
    op.create_table('modules',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('course_id', sa.UUID(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_published', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['course_id'], ['courses.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_modules_course_id'), 'modules', ['course_id'], unique=False)
    op.create_index(op.f('ix_modules_sort_order'), 'modules', ['sort_order'], unique=False)

    # Step 3: Create content_items table (enum type already exists, create_type=False)
    op.create_table('content_items',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('module_id', sa.UUID(), nullable=False),
        sa.Column('problem_id', sa.UUID(), nullable=True),
        sa.Column('item_type', content_item_type_enum, nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_published', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['module_id'], ['modules.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['problem_id'], ['problems.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_content_items_module_id'), 'content_items', ['module_id'], unique=False)
    op.create_index(op.f('ix_content_items_problem_id'), 'content_items', ['problem_id'], unique=False)
    op.create_index(op.f('ix_content_items_sort_order'), 'content_items', ['sort_order'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_content_items_sort_order'), table_name='content_items')
    op.drop_index(op.f('ix_content_items_problem_id'), table_name='content_items')
    op.drop_index(op.f('ix_content_items_module_id'), table_name='content_items')
    op.drop_table('content_items')
    op.drop_index(op.f('ix_modules_sort_order'), table_name='modules')
    op.drop_index(op.f('ix_modules_course_id'), table_name='modules')
    op.drop_table('modules')
    # Drop the PostgreSQL enum type
    op.execute('DROP TYPE IF EXISTS content_item_type_enum')
