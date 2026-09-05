"""Consistency checks on `deploy/`, because there is no cluster to validate against.

`kubectl --dry-run=client` needs a live API server for its OpenAPI schema, so on a machine with no
cluster it validates nothing. These checks are not a substitute — they cannot tell you the manifests
apply — and they are deliberately aimed at the failures a schema check would MISS anyway:

  * a selector that does not match its own pod template → the Deployment applies cleanly and never
    gets a pod
  * a `secretKeyRef` naming a Secret nothing creates → pods stuck in CreateContainerConfigError
  * a probe pointing at a port name the container never declares
  * `INTERNAL_API_SECRET` diverging between the two tiers → every signed request 401s

Every one of those produces a green `kubectl apply` and a broken deployment, which is the same shape
of failure as the rest of this codebase's history.

WHAT THIS FILE CANNOT TELL YOU: whether the manifests actually run. They have never been applied to a
cluster. That is stated in `deploy/README.md` and it should stay stated until someone applies them.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "deploy" / "base"


@pytest.fixture(scope="module")
def objects() -> list[dict]:
    """Render through kustomize when it is available, else parse the files directly.

    Rendering is preferable — it exercises the kustomization, including the namespace
    transformer and the configMapGenerator — but the checks below must still run in an environment
    with no kubectl at all.
    """
    kubectl = subprocess.run(["kubectl", "kustomize", str(BASE)], capture_output=True, text=True)
    if kubectl.returncode == 0 and kubectl.stdout.strip():
        return [d for d in yaml.safe_load_all(kubectl.stdout) if d]

    docs: list[dict] = []
    for path in sorted(BASE.glob("*.yaml")):
        if path.name == "kustomization.yaml":
            continue
        docs.extend(d for d in yaml.safe_load_all(path.read_text(encoding="utf-8")) if d)
    return docs


def of_kind(objects: list[dict], kind: str) -> list[dict]:
    return [o for o in objects if o.get("kind") == kind]


def kustomization_directives() -> str:
    """kustomization.yaml with comments stripped.

    Necessary, not fussy: the file carries a comment reading "NO secretGenerator, on purpose", and
    an assertion over the raw text matches that explanation and calls it a violation. That is the
    THIRD time in this codebase a source-text check has flagged the prose documenting the very rule
    it was enforcing — so the stripping lives in a named helper rather than being re-improvised.
    """
    text = (BASE / "kustomization.yaml").read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


# ── the mistakes that apply cleanly and never work ───────────────────────────

def test_every_deployment_selector_matches_its_own_template(objects) -> None:
    """The single most common manifest bug. Kubernetes accepts it and creates zero pods."""
    for dep in of_kind(objects, "Deployment"):
        name = dep["metadata"]["name"]
        selector = dep["spec"]["selector"]["matchLabels"]
        labels = dep["spec"]["template"]["metadata"]["labels"]
        for key, value in selector.items():
            assert labels.get(key) == value, (
                f"{name}: selector wants {key}={value} but the pod template has "
                f"{key}={labels.get(key)!r} — this Deployment would never get a pod")


def test_every_service_selects_something_that_exists(objects) -> None:
    """A Service whose selector matches nothing has no endpoints, so callers get connection
    refused — which reads as the target being down rather than as a typo."""
    pod_labels = [d["spec"]["template"]["metadata"]["labels"] for d in of_kind(objects, "Deployment")]
    for svc in of_kind(objects, "Service"):
        selector = svc["spec"].get("selector") or {}
        assert selector, f"{svc['metadata']['name']} has no selector"
        assert any(all(labels.get(k) == v for k, v in selector.items()) for labels in pod_labels), (
            f"{svc['metadata']['name']} selects {selector}, which no pod template carries")


def test_every_probe_targets_a_declared_port(objects) -> None:
    """A named port that the container does not declare fails at runtime, not at apply."""
    for dep in of_kind(objects, "Deployment"):
        for container in dep["spec"]["template"]["spec"]["containers"]:
            declared = {p.get("name") for p in container.get("ports", [])}
            for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
                spec = container.get(probe, {}).get("httpGet")
                if spec and isinstance(spec.get("port"), str):
                    assert spec["port"] in declared, (
                        f"{container['name']}.{probe} targets port {spec['port']!r}, "
                        f"declared: {declared or 'none'}")


def test_every_referenced_secret_is_documented_as_created_out_of_band(objects) -> None:
    """No secretGenerator, on purpose — generating Secrets from literals would put them in git.

    The trade is that a missing Secret is a runtime failure, so the names have to be written down
    somewhere a person will look.
    """
    referenced: set[str] = set()
    for dep in of_kind(objects, "Deployment"):
        pod = dep["spec"]["template"]["spec"]
        for container in pod.get("containers", []) + pod.get("initContainers", []):
            for source in container.get("envFrom", []):
                if "secretRef" in source:
                    referenced.add(source["secretRef"]["name"])
            for env in container.get("env", []):
                ref = (env.get("valueFrom") or {}).get("secretKeyRef")
                if ref:
                    referenced.add(ref["name"])

    assert referenced, "no Secret is referenced at all — did the env wiring get dropped?"
    # The full text HERE, comments included: the names are deliberately documented in a
    # comment, because there is no generator to declare them.
    instructions = (BASE / "kustomization.yaml").read_text(encoding="utf-8")
    for name in sorted(referenced):
        assert name in instructions, (
            f"{name} is referenced by a pod but never mentioned in kustomization.yaml, so nobody "
            "knows to create it")


def test_no_secret_values_are_committed(objects) -> None:
    """The one thing this repo has been consistently careful about."""
    for obj in of_kind(objects, "Secret"):
        assert not obj.get("data") and not obj.get("stringData"), (
            f"{obj['metadata']['name']} carries values in git")
    assert "secretGenerator" not in kustomization_directives()


# ── the properties earlier phases established ────────────────────────────────

def test_no_container_runs_as_root(objects) -> None:
    """The namespace enforces `restricted` Pod Security, so a root container is REJECTED at
    admission rather than quietly granted — but only if these blocks are actually present."""
    for dep in of_kind(objects, "Deployment"):
        pod = dep["spec"]["template"]["spec"]
        assert pod.get("securityContext", {}).get("runAsNonRoot") is True, (
            f"{dep['metadata']['name']} does not require a non-root user")
        for container in pod.get("containers", []) + pod.get("initContainers", []):
            ctx = container.get("securityContext", {})
            assert ctx.get("allowPrivilegeEscalation") is False
            assert ctx.get("capabilities", {}).get("drop") == ["ALL"]


def test_every_container_declares_requests_and_limits(objects) -> None:
    """Limits without requests means the scheduler assumes zero and overcommits the node."""
    for dep in of_kind(objects, "Deployment"):
        pod = dep["spec"]["template"]["spec"]
        for container in pod.get("containers", []) + pod.get("initContainers", []):
            resources = container.get("resources", {})
            assert resources.get("requests"), f"{container['name']} has no resource requests"
            assert resources.get("limits"), f"{container['name']} has no resource limits"


def test_a_read_only_rootfs_has_somewhere_writable(objects) -> None:
    """readOnlyRootFilesystem with no writable mount starts fine and then fails the first time
    anything touches a temp file — which presents as an application bug."""
    for dep in of_kind(objects, "Deployment"):
        for container in dep["spec"]["template"]["spec"]["containers"]:
            if container.get("securityContext", {}).get("readOnlyRootFilesystem"):
                assert container.get("volumeMounts"), (
                    f"{container['name']} is read-only with no writable volume")


def test_migrations_run_as_an_init_container_not_in_the_entrypoint(objects) -> None:
    """Two replicas starting together would race each other on the alembic version table.

    This is also what the Dockerfile fix was for: the image did not contain `alembic/`, so this
    container could not have existed.
    """
    api = next(d for d in of_kind(objects, "Deployment")
               if d["metadata"]["name"].endswith("api"))
    init = api["spec"]["template"]["spec"].get("initContainers") or []
    assert any("alembic" in " ".join(c.get("command", [])) for c in init), (
        "nothing runs alembic before the API serves")


def test_the_api_is_not_exposed_through_the_ingress(objects) -> None:
    """Routing the API publicly would restore the unsigned-X-User-Id hole that A2 closed, and would
    publish /metrics, which has no authentication."""
    for ingress in of_kind(objects, "Ingress"):
        for rule in ingress["spec"].get("rules", []):
            for path in rule.get("http", {}).get("paths", []):
                backend = path["backend"]["service"]["name"]
                assert "api" not in backend, (
                    f"the ingress routes {path['path']} straight to {backend}")


def test_sse_buffering_is_disabled_at_the_ingress(objects) -> None:
    """The chat stream and the notification feed both send incrementally. An ingress that buffers
    undoes the non-buffering proxy route — the tutor appears to hang, then dumps its whole answer."""
    ingress = of_kind(objects, "Ingress")[0]
    annotations = ingress["metadata"].get("annotations", {})
    assert annotations.get("nginx.ingress.kubernetes.io/proxy-buffering") == "off"


def test_the_hpa_scales_on_cpu_not_memory(objects) -> None:
    """A Python process's RSS does not fall when load does, so a memory-driven HPA scales up and
    then never scales back down."""
    hpa = of_kind(objects, "HorizontalPodAutoscaler")[0]
    names = {m.get("resource", {}).get("name") for m in hpa["spec"]["metrics"]}
    assert "cpu" in names and "memory" not in names


def test_the_metrics_port_is_annotated_for_scraping(objects) -> None:
    api = next(d for d in of_kind(objects, "Deployment") if d["metadata"]["name"].endswith("api"))
    annotations = api["spec"]["template"]["metadata"].get("annotations", {})
    assert annotations.get("prometheus.io/scrape") == "true"
    assert annotations.get("prometheus.io/path") == "/metrics"


def test_egress_is_default_deny_and_allows_dns(objects) -> None:
    """A default-deny egress policy with no DNS rule breaks every other rule in it, because nothing
    resolves. That is the classic first mistake and it looks like the policy working."""
    egress = [p for p in of_kind(objects, "NetworkPolicy")
              if "Egress" in p["spec"].get("policyTypes", [])]
    assert egress, "no egress policy — a compromised dependency could call anywhere"
    rules = egress[0]["spec"]["egress"]
    ports = [p for rule in rules for p in rule.get("ports", [])]
    assert any(p.get("port") == 53 for p in ports), "egress policy blocks DNS"


# ── the constraint that is invisible in either file alone ────────────────────

def test_the_hpa_ceiling_cannot_exhaust_the_connection_pool(objects) -> None:
    """`maxReplicas` x per-pod pool must fit inside Postgres `max_connections`.

    This is the bug the load test found. The HPA said 10 replicas; the engine is configured
    `pool_size=5, max_overflow=10`, so 10 pods want 150 connections against a `max_connections` of
    100. The API would start refusing connections around 6 replicas *while the HPA kept scaling up*,
    because CPU would still be high — adding pods that cannot connect.

    Neither file is wrong on its own, which is why nothing caught it: the coupling only exists when
    you read `api-hpa.yaml` and `src/database.py` together.

    A rolling update also overlaps old and new pods, so the real peak is above `maxReplicas`. The 25%
    default surge is included below.
    """
    import re

    database = (Path(__file__).resolve().parents[1] / "src" / "database.py").read_text(
        encoding="utf-8")
    pool_size = int(re.search(r"pool_size=(\d+)", database).group(1))
    overflow = int(re.search(r"max_overflow=(\d+)", database).group(1))
    per_pod = pool_size + overflow

    hpa = of_kind(objects, "HorizontalPodAutoscaler")[0]
    max_replicas = hpa["spec"]["maxReplicas"]

    # Measured on the live database, not assumed: `show max_connections` = 100, with ~11 in use by
    # migrations, admin and other clients. Hardcoded because CI has no cluster to ask.
    MAX_CONNECTIONS = 100
    BASELINE_IN_USE = 11
    SURGE = 1.25          # kubectl's default maxSurge for a RollingUpdate

    peak = int(max_replicas * SURGE) * per_pod + BASELINE_IN_USE
    assert peak <= MAX_CONNECTIONS, (
        f"maxReplicas={max_replicas} x {per_pod} connections/pod x {SURGE} rollout surge "
        f"+ {BASELINE_IN_USE} baseline = {peak} > max_connections={MAX_CONNECTIONS}. "
        "Add pgbouncer, raise max_connections, or shrink the pool — do not just raise maxReplicas.")
