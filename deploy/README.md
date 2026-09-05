# deploy/

Kubernetes manifests, a Grafana dashboard, and a load test. Spec §6.2.

## These manifests have never been applied to a cluster

Stated first because it is the most important thing about this directory. `kubectl` 1.36 was
available when they were written and **no cluster was reachable**, so `kubectl apply
--dry-run=client` validated nothing — it needs a live API server for its OpenAPI schema and fails
with `unable to recognize` without one.

## The images ARE verified

Unlike the manifests. `voidcode-web:test` was built and run:

| check | result |
|---|---|
| size | 344 MB (`output: "standalone"`; without it the image needs the whole `node_modules`) |
| runs as | uid 1000, non-root |
| `.env` in the filesystem | none — the guard the release workflow enforces, run by hand |
| `/login`, `/register`, `/forgot-password`, `/reset-password` | all 200, real content |
| Docker `HEALTHCHECK` | `healthy` |
| errors in logs | 0 |

One thing that trips people up and is worth writing down: without `AUTH_TRUST_HOST=true` every route
307s with `UntrustedHost`, because NextAuth refuses to build callbacks for a host it was not told to
trust. The Deployment sets it; a bare `docker run` does not, and the failure looks like a broken app
rather than a missing variable.

What *is* verified about the manifests:

- `kubectl kustomize base` renders 10 objects.
- `apps/api/tests/test_deploy_manifests.py` checks 14 consistency properties, chosen because they
  are what a schema check would **miss**: a selector that does not match its own pod template (which
  applies cleanly and gets zero pods), a `secretKeyRef` naming a Secret nothing creates, a probe on
  an undeclared port name, a read-only rootfs with nowhere writable.

Every one of those produces a green `kubectl apply` and a deployment that does not work. None of
them proves the manifests run.

**Before trusting this:** apply it to a throwaway cluster once, by hand.

## Secrets are not in here

There is no `secretGenerator`, on purpose — generating Secrets from literals would put every value in
git. Create them out of band:

```bash
kubectl -n voidcode create secret generic voidcode-api-secrets --from-env-file=apps/api/.env
kubectl -n voidcode create secret generic voidcode-web-secrets   --from-literal=INTERNAL_API_SECRET=... --from-literal=AUTH_SECRET=...
```

`INTERNAL_API_SECRET` **must be identical in both**. If it is not, every signed request comes back
401 and it looks like a broken session rather than a mismatched secret.

## Decisions that are not obvious from the YAML

**The API is not routed through the ingress.** Everything goes to the web tier, and browser calls
reach the API through `/api/proxy` on the Next.js server — which is what signs the identity.
Exposing the API publicly would restore the unsigned-`X-User-Id` hole and would publish `/metrics`,
which has no authentication.

**Migrations are an initContainer, not the entrypoint.** Two replicas starting together would race on
the alembic version table. A Job would not be ordered against the rollout, so pods could serve
against the old schema.

**The HPA scales on CPU, not memory.** A Python process's RSS does not fall when load does, so a
memory-driven HPA scales up and then never scales back down.

**`proxy-buffering: off`.** The chat stream and notification feed send incrementally. An ingress that
buffers undoes the non-buffering proxy route: the tutor appears to hang for a whole generation and
then dumps its answer at once.

**There is an egress NetworkPolicy, not only ingress.** Ingress stops people getting in; egress stops
data getting out, and exfiltration is the half that matters after a compromise. Its DNS rule is
load-bearing — a default-deny egress policy without one breaks every other rule in it, because
nothing resolves.

**Judge0 is not in this namespace.** The namespace enforces `restricted` Pod Security, and Judge0
needs `privileged: true` for isolate. It belongs in its own namespace with its own, looser policy.

## loadtest.py

Read paths only, no writes. `python deploy/loadtest.py --url http://127.0.0.1:8000`.

**No valid measurement has been recorded yet.** The first attempt produced a 30 s timeout on
`/v1/dashboard`, which turned out to be Postgres being unreachable — a concurrent Docker build had
saturated the machine and wedged the engine — not an endpoint problem. A direct
`select count(*) from problems` timed out identically, which is what proved it environmental.

That distinction is the point: reporting "the dashboard endpoint is slow" from that run would have
been a fabricated finding. Re-run it against a healthy environment before quoting any number.

It fails on errors and **not** on latency. There is no agreed SLO for this product, and a threshold
invented in a test file is how a number nobody chose becomes a number somebody quotes.
