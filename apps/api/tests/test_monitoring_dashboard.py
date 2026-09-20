"""The Grafana dashboard asks for series that exist.

WHY THIS FILE EXISTS. `metrics.py` records a correction in its own docstring: two panels measured
the rollout of signed identity headers, the headers went with the website, and "a dashboard panel
that can only read zero is read as a live risk by whoever opens it next". The panels were removed
by hand, and nothing would have noticed if they had not been -- a dashboard is a JSON file no test
had ever opened.

Both directions of that failure are here. A panel naming a metric the API does not declare renders
a flat line at zero, which reads as "nothing is wrong" and is indistinguishable from a healthy
system; and a metric renamed in `metrics.py` silently orphans every panel built on it.

NOT A CHECK THAT GRAFANA RENDERS IT. Nothing here starts a Grafana, and `docs/SUPERSEDED-SPECS.md`
is explicit that this is a file rather than a running dashboard. What is checkable without one is
whether the file is internally consistent and agrees with the code -- which is the part that goes
wrong silently.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
DASHBOARD = REPO / "deploy" / "monitoring" / "grafana-voidcode.json"

#: Series suffixes prometheus_client adds per metric type. A Counter declared as
#: `voidcode_sandbox_verdicts_total` is collected under the base name with `_total` appended back on
#: at sample time, so a naive comparison against the declared string fails on half the metrics.
_SUFFIXES = {
    "counter": ("_total", "_created"),
    "gauge": ("",),
    "histogram": ("_bucket", "_sum", "_count", "_created"),
    "summary": ("_sum", "_count", "_created"),
}


@pytest.fixture(scope="module")
def dashboard() -> dict:
    return json.loads(DASHBOARD.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def declared_series() -> set[str]:
    """Every series name the API can actually emit, from the registry rather than from the source.

    Asked of the live registry because that is what a scrape returns. Reading the declarations out
    of `metrics.py` as text would agree with a typo in the file it is checking.
    """
    from src import metrics

    assert metrics.REGISTRY is not None, "prometheus_client is missing; every check here is vacuous"
    names: set[str] = set()
    for metric in metrics.REGISTRY.collect():
        for suffix in _SUFFIXES.get(metric.type, ("",)):
            names.add(metric.name + suffix)
    return names


def _exprs(dashboard: dict) -> list[tuple[str, str]]:
    """(panel title, expr) for every target in the dashboard."""
    found = []
    for panel in dashboard["panels"]:
        for target in panel.get("targets", []):
            expr = target.get("expr")
            if expr:
                found.append((panel["title"], expr))
    return found


def test_every_panel_queries_a_series_the_api_declares(dashboard, declared_series):
    """THE ONE THAT MATTERS. A panel on a metric that does not exist reads as zero, not as broken."""
    queried = _exprs(dashboard)
    assert queried, "the dashboard has no queries at all; this test guards nothing"

    unknown = []
    for title, expr in queried:
        # Only our own namespace: rate, sum, by and friends are PromQL, not metrics.
        for name in set(re.findall(r"\bvoidcode_[a-z0-9_]+", expr)):
            if name not in declared_series:
                unknown.append((title, name))

    assert not unknown, (
        "these panels query series the API does not declare, so each renders a flat zero that "
        f"looks like good news: {unknown}. Declared: {sorted(declared_series)}"
    )


def test_every_panel_queries_something(dashboard):
    """A panel with no target is a blank rectangle, and blank reads as quiet."""
    for panel in dashboard["panels"]:
        assert panel.get("targets"), f"{panel['title']!r} has no query"
        assert panel.get("datasource"), f"{panel['title']!r} has no datasource"


def test_every_panel_says_what_a_reader_should_do_about_it(dashboard):
    """A number without a threshold is a number nobody acts on.

    Every panel here carries prose explaining what a non-zero value means and what to do. That is
    the convention the first three set deliberately -- the dashboard is opened by whoever is on call
    at the time, who has not read the module that emits the series.
    """
    for panel in dashboard["panels"]:
        description = panel.get("description", "")
        assert len(description) > 80, (
            f"{panel['title']!r} has no real description. The panel tells a reader a number; the "
            "description is the only thing that tells them whether it is bad."
        )


def test_panel_ids_are_unique_and_layout_does_not_overlap(dashboard):
    """Two panels at the same gridPos render on top of each other, and duplicate ids break links."""
    panels = dashboard["panels"]
    ids = [panel["id"] for panel in panels]
    assert len(set(ids)) == len(ids), f"duplicate panel ids: {ids}"

    occupied: dict[tuple[int, int], str] = {}
    for panel in panels:
        pos = panel["gridPos"]
        assert pos["x"] + pos["w"] <= 24, f"{panel['title']!r} runs off the 24-column grid"
        for x in range(pos["x"], pos["x"] + pos["w"]):
            for y in range(pos["y"], pos["y"] + pos["h"]):
                clash = occupied.get((x, y))
                assert clash is None, f"{panel['title']!r} overlaps {clash!r} at ({x}, {y})"
                occupied[(x, y)] = panel["title"]


def test_the_backend_state_panel_carries_the_alert_expression(dashboard, declared_series):
    """The panel exists so somebody can alert on it, and the expression has to be in the file.

    `/health` has reported `backendState` all along; it is polled by the kubelet and scraped by
    nothing, so the answer decided a readiness bit and reached no alerting rule. A panel that shows
    the state without saying which value pages leaves the reader to guess which of three labels is
    the bad one.
    """
    from src.services import backend_registry

    panel = next(
        (p for p in dashboard["panels"] if "voidcode_inference_backend_state" in json.dumps(p)),
        None,
    )
    assert panel is not None, (
        "no panel reads voidcode_inference_backend_state, so the series is emitted and unread -- "
        "which is the state this metric was added to end"
    )

    assert "voidcode_inference_backend_state" in declared_series

    text = json.dumps(panel)
    assert 'state=\\"down\\"' in text, (
        "the panel does not name down as the alertable state. One of three labels is a page and the "
        "other two are not; a reader on call should not have to work out which."
    )
    for state in backend_registry.STATES:
        assert state in text.lower(), (
            f"the panel's prose does not mention {state!r}, which is a value the series can take. "
            "An operator seeing it needs to know whether it is the bad one."
        )
    # The series is absent on the in-process paths, and absent-is-not-zero is the kind of thing a
    # reader assumes wrongly unless told.
    assert "absent" in panel["description"].lower(), (
        "the description does not explain that no series at all is the in-process case rather than "
        "a scrape failure"
    )


def test_the_dashboard_stays_canonical_two_space_json(dashboard):
    """Reformatting this file makes every future diff unreadable, which is how panels get lost.

    LINE ENDINGS ARE NORMALISED BEFORE COMPARING, and the earlier version of this test got that
    wrong in a way that could only ever fail somewhere else. It built the expected bytes by
    replacing every newline with a carriage-return pair and compared them to the file, so it
    asserted the file was CRLF **on disk**.

    That is not a property of the repository. Git stores this blob with LF — `git show HEAD:<path>`
    confirms it — and what lands in a working tree depends on the checker-out's `core.autocrlf`. So
    it passed on the machine it was written on and would have failed on every CI runner. It did: the
    first time any workflow ran this was among the failures, and it only became visible locally
    after a branch switch re-materialised the file through git's own normalisation.

    What IS worth holding is below. The content is exactly `json.dumps(indent=2)` output, so a diff
    shows the panel that changed rather than the whole file; and the endings are CONSISTENT, because
    a half-converted file is what makes a diff unreadable regardless of which convention won.
    """
    raw = DASHBOARD.read_bytes()
    canonical = (json.dumps(dashboard, indent=2) + "\n").encode()
    assert raw.replace(b"\r\n", b"\n") == canonical, (
        "the dashboard is no longer canonical 2-space JSON. Write it with json.dumps(indent=2) "
        "rather than by hand."
    )

    crlf_count = raw.count(b"\r\n")
    bare_lf = raw.replace(b"\r\n", b"").count(b"\n")
    assert crlf_count == 0 or bare_lf == 0, (
        f"the dashboard has mixed line endings ({crlf_count} CRLF and {bare_lf} bare LF). "
        "Whichever convention it uses it has to use one, or every diff shows lines nobody edited."
    )
