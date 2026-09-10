"""record what each request cost to serve, alongside what it was billed

Revision ID: c5e9f21a3b48
Revises: b4d8e10c2f37
Create Date: 2026-09-10 08:30:00.000000

WHY THIS IS URGENT RATHER THAN TIDY

`gpu_reservations` recorded revenue (`settled_micro`) and no cost, so margin was not a query. It
could only be recomputed by hand against `gpu_pricing.PRICING`, a Python tuple that is append-only
and dated -- which means the recomputation gets harder every time the price changes, and is already
approximate for any request served under a row that has since been superseded.

That is a data-loss clock, not a missing feature: every request served without these columns is
permanently un-auditable for margin. Nothing else in the remaining work has that property, which is
why this landed before the larger items.

WHY THE INPUTS AND NOT JUST THE COST

`cost_micro` alone cannot be checked. Storing `pod_micro_per_hour`, `nominal_concurrency` and
`margin_bps` beside it makes the derivation reproducible from the row:

    cost_micro == ceil_div(pod_micro_per_hour * slot_ms, 3600 * 1000 * nominal_concurrency)

and margin becomes `settled_micro - cost_micro` in plain SQL, with no join back to Python.

`pricing_measured` IS THE HONEST PART, AND IT IS CURRENTLY FALSE

Both shipped pricing rows carry `measured=False`. `nominal_concurrency` is 16 because that is
`MAX_CONCURRENT_REQUESTS`, an API-side semaphore count -- it is not a measured property of an A40.
If the card actually serves six concurrent requests rather than sixteen, every `cost_micro` written
today understates the true cost by nearly threefold while remaining arithmetically correct, which is
exactly the failure mode `scripts/pod_bench_serving.sh` exists to remove.

So this column is not decoration. A margin query that does not filter on `pricing_measured = true`
is reporting an assumption as a measurement. Once the serving benchmark lands and a measured row
ships, old rows stay honestly marked instead of being retroactively reinterpreted.

ALL FIVE COLUMNS ARE NULLABLE, ON PURPOSE

Rows written before this migration have no cost basis and there is no defensible value to backfill
them with -- unlike `gpu_grant_keys` in the previous revision, where the ledger held the answer.
Nullable also means every existing write site (which enumerates its columns) and every read site
(which is a hand-built projection) keeps working untouched. `NOT NULL` here would break the sweep,
which voids a reservation without ever knowing a price.

A NOTE ON SPIN-DOWN, FOR WHOEVER READS THIS AFTER IT LANDS

`pod_micro_per_hour` describes a pod billed continuously. Once idle pods are stopped between
sessions, the first request after a wake has also paid for the boot, and `cost_micro` becomes
"marginal cost at the assumed continuous rate" rather than a share of a real hour. That is
acceptable precisely because `pricing_measured` records that the basis is an assumption.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'c5e9f21a3b48'
down_revision: str | None = 'b4d8e10c2f37'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('gpu_reservations', sa.Column('cost_micro', sa.BigInteger(), nullable=True))
    op.add_column(
        'gpu_reservations', sa.Column('pod_micro_per_hour', sa.BigInteger(), nullable=True)
    )
    op.add_column(
        'gpu_reservations', sa.Column('nominal_concurrency', sa.Integer(), nullable=True)
    )
    op.add_column('gpu_reservations', sa.Column('margin_bps', sa.Integer(), nullable=True))
    op.add_column('gpu_reservations', sa.Column('pricing_measured', sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column('gpu_reservations', 'pricing_measured')
    op.drop_column('gpu_reservations', 'margin_bps')
    op.drop_column('gpu_reservations', 'nominal_concurrency')
    op.drop_column('gpu_reservations', 'pod_micro_per_hour')
    op.drop_column('gpu_reservations', 'cost_micro')
