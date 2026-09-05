"""add knowledge_documents for V2 retrieval

Revision ID: b8e3d1f07a26
Revises: a1c7f2e9d4b3
Create Date: 2026-08-10

The corpus behind V2. Attention variants, quantization schemes and CUDA occupancy rules churn
continuously, and a tutor holding those in weights teaches superseded material confidently — to a
learner who cannot detect the error, because someone preparing for an interview does not yet know
enough to catch it.

WHY `embedding` IS TEXT AND NOT `vector(768)`
-----------------------------------------------
pgvector is not installed on this database and `CREATE EXTENSION` requires superuser, which a
migration run by the application role generally does not have. Declaring the column as `vector`
here would make this migration fail on any environment without the extension pre-provisioned —
including a developer's local Postgres and CI.

So the column is TEXT and the corpus is queryable without pgvector, just not efficiently. The
follow-up migration that adds the extension and converts the column is a one-liner once someone
with the right grants has run `CREATE EXTENSION vector`; the schema and the ingest path do not
change. Recorded rather than worked around, because "why is this text" is otherwise the sort of
thing that reads as an oversight.
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b8e3d1f07a26"
down_revision = "a1c7f2e9d4b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "knowledge_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("slug", sa.String(length=128), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        # The citation. A claim the tutor cannot attribute is a claim it should not make.
        sa.Column("source_url", sa.String(length=512), nullable=True),
        sa.Column("source_name", sa.String(length=128), nullable=True),
        # What lets a reader judge staleness. A quantization claim from 2023 and one from last
        # month are not interchangeable, and only the date says so.
        sa.Column("published_at", sa.DateTime(), nullable=True),
        sa.Column("concept_id", sa.String(length=64), nullable=True),
        sa.Column("embedding_dim", sa.Integer(), nullable=True),
        sa.Column("embedding", sa.Text(), nullable=True),
        sa.Column("superseded_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        # SET NULL rather than CASCADE: losing the replacement must not delete the history that
        # points at it. Deletion loses the trail, which is what versioning exists to keep.
        sa.ForeignKeyConstraint(["superseded_by_id"], ["knowledge_documents.id"],
                                ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug", "version", name="uq_knowledge_slug_version"),
    )
    op.create_index("ix_knowledge_documents_slug", "knowledge_documents", ["slug"])
    op.create_index("ix_knowledge_documents_concept_id", "knowledge_documents", ["concept_id"])
    op.create_index("ix_knowledge_documents_is_current", "knowledge_documents", ["is_current"])
    # Retrieval filters to current documents before ranking by distance.
    op.create_index("ix_knowledge_current", "knowledge_documents", ["is_current", "concept_id"])


def downgrade() -> None:
    for name in ("ix_knowledge_current", "ix_knowledge_documents_is_current",
                 "ix_knowledge_documents_concept_id", "ix_knowledge_documents_slug"):
        op.drop_index(name, table_name="knowledge_documents")
    op.drop_table("knowledge_documents")
