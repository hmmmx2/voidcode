"""Drop user_identities, because Google and Microsoft sign-in is gone

THE TABLE HAS NO READER LEFT. `services/oidc.py` and `services/account_linking.py` are deleted, the
`POST /v1/auth/desktop/oauth/{provider}` route with them, and `/v1/auth/me` no longer returns a
`providers` list — that field was a SELECT against this table and is removed from the response model
as well. `models/user_identity.py` is gone, so leaving the table behind would mean the next
`alembic revision --autogenerate` emits this DROP anyway, in a migration written for something else,
with nobody reading the line. `tests/test_migrations_match_models_postgres.py` is what turns that
from a latent surprise into a failing check, which is why it had to land first.

THIS IS NOT REVERSIBLE IN THE SENSE THAT MATTERS. `downgrade()` recreates the table exactly as
`a7c3e9f1b204` built it — same columns, same two unique constraints, same index, same cascade — so
the schema round-trips. THE ROWS DO NOT. Downgrading gives you an empty table, and the links it held
can only be rebuilt by each person signing in through their provider again, which is precisely what
the code being removed here used to do. Read `downgrade()` as "the shape comes back", not "the data
comes back".

WHAT IS DELIBERATELY LEFT ALONE. `a7c3e9f1b204` also added `users.terms_accepted_at`,
`users.terms_version` and `auth_tokens.attempts`. All three stay and are actively used: the first two
record which version of the documents a person accepted — including rows that accepted a version
naming Google and Microsoft, which stay exactly as they are, because rewriting a consent record to
match today's document would falsify it — and `attempts` is the per-code wrong-guess counter that
makes reset-by-code safe. This migration touches one table.

WHO THIS AFFECTS. Accounts that were created through a provider and never set a password. They keep
their row in `users`; what they lose is the link that let them sign in. The route back in is
"Forgot password?": the API issues a reset code to accounts with no password ON PURPOSE, because
receiving the code proves control of the mailbox, which is the proof setting a first password needs.
Privacy Policy 6.4 now says so in writing rather than leaving it to be inferred.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b4f8e27c9a13"
down_revision: str | None = "a7c3e9f1b204"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The index goes first: dropping the table would take it, but naming it here keeps the two
    # halves of this migration symmetrical with `downgrade()` and with a7c3e9f1b204's `upgrade()`.
    op.drop_index("ix_user_identities_user_id", table_name="user_identities")
    op.drop_table("user_identities")


def downgrade() -> None:
    """The shape, exactly as a7c3e9f1b204 created it. Not the rows — see the module docstring."""
    op.create_table(
        "user_identities",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=64), nullable=True),
        sa.Column("email_at_link", sa.String(length=255), nullable=True),
        sa.Column("email_trusted_at_link", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "subject", name="uq_user_identities_provider_subject"),
        sa.UniqueConstraint("user_id", "provider", name="uq_user_identities_user_provider"),
    )
    op.create_index("ix_user_identities_user_id", "user_identities", ["user_id"], unique=False)
