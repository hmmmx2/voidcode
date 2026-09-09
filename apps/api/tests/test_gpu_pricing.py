"""The money arithmetic, and the rules about it that a reviewer cannot enforce by reading.

These need no database and no GPU, which is deliberate: the conftest docstring argues that the tests
that matter most are the ones with no infrastructure between them and the logic, and every defect
this module can have lives in a pure function.
"""

import ast
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.services import gpu_pricing
from src.services.gpu_pricing import PricingRow, ceil_div, hold_micro_for, rate_for

SRC = Path(__file__).resolve().parents[1] / "src"
MONEY_MODULES = (
    SRC / "services" / "gpu_pricing.py",
    SRC / "services" / "gpu_wallet_service.py",
)


class TestCeilDiv:
    def test_rounds_up_and_never_returns_a_float(self):
        for numerator, denominator, expected in [
            (0, 1000, 0), (1, 1000, 1), (999, 1000, 1), (1000, 1000, 1), (1001, 1000, 2),
        ]:
            result = ceil_div(numerator, denominator)
            assert result == expected
            # `1000 / 1000 == 1.0` compares equal to 1, so the value assertion alone would pass on a
            # float. The type is the thing under test.
            assert isinstance(result, int) and not isinstance(result, bool)

    def test_a_zero_or_negative_denominator_is_refused_rather_than_returning_nonsense(self):
        with pytest.raises(ValueError):
            ceil_div(1, 0)
        with pytest.raises(ValueError):
            ceil_div(1, -1)

    def test_it_does_not_lose_precision_where_float_division_would(self):
        """The reason this exists rather than `math.ceil(a / b)`.

        A float has 53 bits of mantissa. At micro-credit scale a busy month exceeds that, and the
        failure is silent: the wrong number is returned, not an error.
        """
        big = 2**53 + 1
        assert ceil_div(big, 1) == big
        # What the float route would have produced, shown so the difference is not theoretical.
        assert int(big / 1) != big


class TestPricingRow:
    def test_full_utilisation_of_every_slot_recovers_one_pod_hour(self):
        """The property the whole unit rests on.

        With continuous batching, N concurrent requests each accrue a full wall-clock second per
        second, so they sum to N slot-seconds per GPU-second. Charging pod-cost-per-second to each
        would over-recover N times over. Dividing by nominal concurrency is what makes a fully busy
        hour recover exactly one pod-hour.
        """
        row = PricingRow(
            effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
            pod_micro_per_hour=36_000_000, nominal_concurrency=10, margin_bps=10_000,
            gpu="test", model="test", measured=True,
        )
        recovered = row.rate_micro_per_slot_second * 3600 * row.nominal_concurrency
        # Rounding up per slot-second can only over-recover, and only by rounding dust.
        assert recovered >= row.pod_micro_per_hour
        assert recovered - row.pod_micro_per_hour < 3600 * row.nominal_concurrency

    def test_under_utilisation_under_recovers_which_is_the_correct_direction(self):
        """Idle capacity is the operator's cost, not a learner's. Half-busy recovers about half."""
        row = PricingRow(
            effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
            pod_micro_per_hour=36_000_000, nominal_concurrency=10, margin_bps=10_000,
            gpu="test", model="test", measured=True,
        )
        half = row.rate_micro_per_slot_second * 3600 * (row.nominal_concurrency // 2)
        assert half < row.pod_micro_per_hour

    def test_the_rate_is_an_integer(self):
        row = PricingRow(
            effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
            pod_micro_per_hour=49_000_000, nominal_concurrency=16, margin_bps=15_000,
            gpu="test", model="test", measured=True,
        )
        assert isinstance(row.rate_micro_per_slot_second, int)

    def test_margin_raises_the_rate(self):
        def rate(margin: int) -> int:
            return PricingRow(
                effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
                pod_micro_per_hour=49_000_000, nominal_concurrency=16, margin_bps=margin,
                gpu="test", model="test", measured=True,
            ).rate_micro_per_slot_second

        assert rate(15_000) > rate(10_000)


class TestDatedTable:
    def test_a_past_instant_gets_the_row_that_was_live_then_not_the_newest(self):
        """Why the table is dated at all: a settled request must never re-price."""
        old = PricingRow(
            effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
            pod_micro_per_hour=10_000_000, nominal_concurrency=8, margin_bps=10_000,
            gpu="old", model="m", measured=True,
        )
        new = PricingRow(
            effective_from=datetime(2026, 6, 1, tzinfo=timezone.utc),
            pod_micro_per_hour=90_000_000, nominal_concurrency=8, margin_bps=10_000,
            gpu="new", model="m", measured=True,
        )
        original = gpu_pricing.PRICING
        gpu_pricing.PRICING = (old, new)
        try:
            assert rate_for(datetime(2026, 3, 1, tzinfo=timezone.utc)).gpu == "old"
            assert rate_for(datetime(2026, 7, 1, tzinfo=timezone.utc)).gpu == "new"
            # Exactly on the boundary the newer row wins — `effective_from` is inclusive.
            assert rate_for(datetime(2026, 6, 1, tzinfo=timezone.utc)).gpu == "new"
        finally:
            gpu_pricing.PRICING = original

    def test_an_instant_before_the_table_starts_raises_rather_than_guessing(self):
        with pytest.raises(ValueError):
            rate_for(datetime(2000, 1, 1, tzinfo=timezone.utc))

    def test_the_shipped_price_is_still_marked_unmeasured(self):
        """A guard on honesty, not on arithmetic.

        The shipped row is a placeholder: throughput per slot for the served model on an A40 has
        never been measured. When someone measures it and adds a real row, this test fails and makes
        them delete it deliberately — which is the moment to check that the reconciliation test also
        started passing.
        """
        row = rate_for(datetime(2026, 9, 10, tzinfo=timezone.utc))
        assert row.measured is False
        assert "PLACEHOLDER" in row.note


class TestHold:
    def test_the_hold_covers_the_worst_case_not_the_expected_case(self):
        hold = hold_micro_for(120, floor_micro=0, when=datetime(2026, 9, 10, tzinfo=timezone.utc))
        rate = rate_for(datetime(2026, 9, 10, tzinfo=timezone.utc)).rate_micro_per_slot_second
        assert hold == 120 * rate

    def test_the_floor_applies_to_the_hold_so_a_trivial_request_is_still_refusable(self):
        """A one-token reply still occupied a slot. If the floor were only applied at settle, a
        learner with almost nothing could start a request they cannot pay the floor on."""
        hold = hold_micro_for(
            1, floor_micro=10**9, when=datetime(2026, 9, 10, tzinfo=timezone.utc)
        )
        assert hold == 10**9


class TestTheMoneyPathHasNoFloats:
    """Enforced by reading the source, because a float here is invisible until the numbers are big.

    `assertIsInstance(x, int)` on a return value cannot catch an intermediate that went through a
    float and came back — `int(0.1 + 0.2)` is an int too. The only reliable check is that the
    operations are absent from the module at all.
    """

    @pytest.mark.parametrize("path", MONEY_MODULES, ids=lambda p: p.name)
    def test_no_true_division_and_no_math_ceil(self, path: Path):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        offenders = []
        for node in ast.walk(tree):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
                offenders.append(f"{path.name}:{node.lineno} true division (`/`)")
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in {"ceil", "floor"}
            ):
                offenders.append(f"{path.name}:{node.lineno} math.{node.func.attr}")
            # A float literal is how the margin first got in: `margin: float = 1.5` passed the
            # division and math.ceil checks above while still putting a float in the arithmetic.
            if isinstance(node, ast.Constant) and isinstance(node.value, float):
                offenders.append(f"{path.name}:{node.lineno} float literal {node.value!r}")
        assert offenders == [], f"floats on the money path: {offenders}"

    @pytest.mark.parametrize("path", MONEY_MODULES, ids=lambda p: p.name)
    def test_no_float_or_decimal_columns_are_introduced(self, path: Path):
        source = path.read_text(encoding="utf-8")
        assert not re.search(r"\bFloat\b|\bNumeric\b|\bDecimal\b", source)


class TestModelInvariantsAreConstraintsNotComments:
    """The CHECKs are the first in this codebase, so assert they are actually declared.

    A constraint that lives only in a docstring is a comment. These four are the difference between
    "the service should not oversell" and "the database will not let it".
    """

    def test_the_wallet_and_reservation_invariants_are_declared(self):
        from src.models.gpu_billing import GpuReservation, GpuWallet

        def check_names(model) -> set[str]:
            return {
                c.name for c in model.__table__.constraints if c.__class__.__name__ == "CheckConstraint"
            }

        assert "ck_gpu_wallets_reserved_le_balance" in check_names(GpuWallet)
        assert "ck_gpu_wallets_balance_nonneg" in check_names(GpuWallet)
        assert "ck_gpu_reservations_settled_le_hold" in check_names(GpuReservation)
        assert "ck_gpu_reservations_state_consistent" in check_names(GpuReservation)

    def test_the_ledger_idempotency_key_is_unique(self):
        """Idempotency is a constraint, not an application check — this asserts it stayed one."""
        from src.models.gpu_billing import GpuLedger

        uniques = {
            c.name for c in GpuLedger.__table__.constraints
            if c.__class__.__name__ == "UniqueConstraint"
        }
        assert "uq_gpu_ledger_idempotency_key" in uniques
