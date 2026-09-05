"""add password auth fields to users

Adds the four columns email+password auth needs, backfills them for the
existing OAuth accounts, and makes email uniqueness case-insensitive.

`password_hash` is NOT added here — it has existed since the initial schema
(`ac9a1b3b96f9`) and has simply never been read or written.

WHY THE NEW TIMESTAMPS ARE TIMEZONE-AWARE WHEN EVERY EXISTING ONE IS NAIVE

This is a deliberate break with `created_at` / `updated_at`, which use naive
`datetime.utcnow()`. These are the first timestamps in this schema that get
*compared* rather than merely displayed — the reset flow asks "is this token
still valid", and comparing a naive datetime with an aware one raises
`TypeError: can't compare offset-naive and offset-aware datetimes` at runtime.
That failure would land in the password-reset path, which is the worst place in
the application to discover it. Aware columns make the mistake impossible.

Revision ID: b1c2d3e4f5a6
Revises: a7b2c3d4e5f6
"""

import sqlalchemy as sa
from alembic import op

revision = "b1c2d3e4f5a6"
down_revision = "a7b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # ── Guard: case-insensitive email collisions ──────────────────
    #
    # The unique index below is on `lower(email)`, but today's constraint is on
    # the raw value — so `Alice@x.com` and `alice@x.com` are two valid rows
    # right now. Creating the index on such a table fails with a bare
    # `UniqueViolation` naming an index, which tells an operator nothing about
    # which accounts to merge.
    #
    # This runs first and names them. Resolving it is a human decision (which
    # account keeps the submissions?), so the migration refuses rather than
    # guessing.
    duplicates = conn.execute(
        sa.text(
            """
            SELECT lower(email) AS normalised,
                   count(*)     AS n,
                   string_agg(email, ', ' ORDER BY created_at) AS variants
            FROM users
            GROUP BY lower(email)
            HAVING count(*) > 1
            """
        )
    ).fetchall()

    if duplicates:
        detail = "\n".join(
            f"  {row.normalised}: {row.n} rows — {row.variants}" for row in duplicates
        )
        raise RuntimeError(
            "Cannot create the case-insensitive email index: these addresses "
            "already exist in more than one casing.\n"
            f"{detail}\n"
            "Merge or delete the duplicates by hand, then re-run this migration. "
            "Decide deliberately which row keeps its submissions and chat history."
        )

    # ── Columns ───────────────────────────────────────────────────
    op.add_column(
        "users",
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
    )
    # NOT NULL with a server default, so existing rows get 0 without a second
    # pass and concurrent inserts during deploy cannot land a NULL.
    op.add_column(
        "users",
        sa.Column(
            "token_version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )

    # ── Backfill ──────────────────────────────────────────────────
    #
    # Every existing account arrived through Google or Microsoft, and completing
    # that flow proves control of the mailbox — so they are verified, and
    # marking them so is not a shortcut. Leaving them NULL would lock every
    # current user out the moment the unverified-login check ships.
    #
    # This includes the seeded developer account. If the database is ever
    # recreated from scratch *after* this ships, `main.py`'s lifespan seeder
    # must set `email_verified_at` itself or that account cannot sign in.
    op.execute(
        "UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL"
    )

    # ── Case-insensitive uniqueness ───────────────────────────────
    #
    # Application-level `email.lower()` is a convention; this is an invariant.
    # Without it, one code path that forgets to normalise silently creates a
    # second account for the same person — and the OAuth and password paths
    # would each have to remember, forever.
    #
    # The existing `ix_users_email` unique index stays: it is on the raw value
    # and costs little, and dropping it would remove the index backing lookups
    # that query `email` directly.
    op.create_index(
        "ix_users_email_lower",
        "users",
        [sa.text("lower(email)")],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_users_email_lower", table_name="users")
    op.drop_column("users", "token_version")
    op.drop_column("users", "password_changed_at")
    op.drop_column("users", "last_login_at")
    op.drop_column("users", "email_verified_at")
