"""add gpu_slots and gpu_queue_tickets: a fleet-wide serving budget and the queue for it

Revision ID: e91f4c02a7d8
Revises: d7a3b91c6e05
Create Date: 2026-09-10 09:00:00.000000

WHAT THIS FIXES IS BIGGER THAN THE 503 IT REPLACES

`MAX_CONCURRENT_REQUESTS` bounds concurrency per PROCESS. `deploy/base/api-hpa.yaml` runs two to
four replicas. So the fleet can push 32 to 64 concurrent requests at a backend sized for 16 while
every replica is correctly within its own limit and none can see the others. The in-process
semaphore was never a statement about the pod, and no amount of tuning it makes it one.

`gpu_slots` is that statement: a fixed number of rows, and holding one is what entitles a request to
occupy the backend. The semaphore stays for the job it does do -- on the HuggingFace path
`model.generate()` runs in a thread and more than two concurrent risks OOM in this process.

THE ROW COUNT IS THE CAPACITY, AND CHANGING IT IS A MIGRATION ON PURPOSE

Capacity could have been an environment variable. It is a table because an environment variable can
differ between replicas and a table cannot, and because a capacity change deserves the same review
as a schema change. Sixteen rows are seeded here to match the SGLang default that has been in use;
that number is currently unmeasured -- `gpu_pricing` ships `measured=False` for exactly this figure
-- so expect it to move once the serving benchmark lands.

WHY A LEASE AND NOT A COUNTER

A counter must be decremented on release, and a replica killed mid-request never releases. Repairing
that needs a sweeper plus a guess about how long is too long, and a bug the first time the guess is
wrong. A leased row repairs itself: `leased_until` passes and the slot is claimable again with
nothing having had to survive to say so. Nothing sweeps `gpu_slots`, deliberately.

NO FOREIGN KEY FROM `gpu_slots.holder` TO ANYTHING

It names a ticket, and a ticket is deleted as soon as its request finishes. A foreign key would
either block that delete or cascade a live slot to free. The column is an identity to compare
against in a WHERE clause, not a relationship.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'e91f4c02a7d8'
down_revision: str | None = 'd7a3b91c6e05'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Matches the SGLang-path default of `MAX_CONCURRENT_REQUESTS`. See the docstring: unmeasured.
SEEDED_SLOTS = 16


def upgrade() -> None:
    op.create_table(
        'gpu_slots',
        sa.Column('id', sa.SmallInteger(), autoincrement=False, nullable=False),
        sa.Column('holder', sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('leased_until', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id', name='pk_gpu_slots'),
    )
    op.create_index('ix_gpu_slots_free', 'gpu_slots', ['leased_until'])

    # Seeded here rather than at startup. A replica seeding on boot would race every other replica
    # booting at the same time, and "how many slots exist" would depend on who won.
    op.execute(
        "INSERT INTO gpu_slots (id) "
        f"SELECT generate_series(1, {SEEDED_SLOTS}) "
        "ON CONFLICT (id) DO NOTHING"
    )

    op.create_table(
        'gpu_queue_tickets',
        sa.Column('id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('request_id', sa.String(length=64), nullable=False),
        sa.Column('state', sa.String(length=16), nullable=False),
        sa.Column('replica', sa.String(length=64), nullable=True),
        sa.Column('heartbeat_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint('id', name='pk_gpu_queue_tickets'),
    )
    # Position is `count(*) WHERE state = 'waiting' AND created_at < mine`. Without this index every
    # tick of every waiter is a sequential scan, and the queue gets slower the longer it gets.
    op.create_index('ix_gpu_queue_waiting', 'gpu_queue_tickets', ['state', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_gpu_queue_waiting', table_name='gpu_queue_tickets')
    op.drop_table('gpu_queue_tickets')
    op.drop_index('ix_gpu_slots_free', table_name='gpu_slots')
    op.drop_table('gpu_slots')
