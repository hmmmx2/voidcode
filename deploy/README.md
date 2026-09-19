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
| `/`, `/terms`, `/privacy`, `/purchase/success`, `/purchase/cancelled` | all 200, real content — **this run predates `/pricing` and `/download`**, which were split out of the overview afterwards and are not covered by the measurement above |
| Docker `HEALTHCHECK` | `healthy` |
| errors in logs | 0 |

That table used to list `/login`, `/register` and the two password-reset routes, and a note about
`AUTH_TRUST_HOST=true` without which every route 307'd with `UntrustedHost`. None of it applies: the
web tier has no auth, no session and no API calls. Sign-in is in the desktop app.

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
```

One secret, for the API. There is no `voidcode-web-secrets` any more: the web tier is static pages
that sign nothing and hold no session.

When Google and Microsoft sign-in lands, two more values join this: `OAUTH_GOOGLE_CLIENT_IDS` and
`OAUTH_MICROSOFT_CLIENT_IDS` belong in the ConfigMap above — they are public identifiers that the
desktop binary also ships — while `OAUTH_GOOGLE_CLIENT_SECRET` goes in the Secret, because the API
redeems the authorization code rather than the app. `assert_production_config()` warns but starts
with none of them set, since email and password sign-in is a complete product on its own.

## Decisions that are not obvious from the YAML

**The API has its own host, and only `/v1` on it.** `api.<domain>` routes to `voidcode-api` with
one `Prefix` rule. Nothing was routed to the API before, which was right while browser traffic
reached it through `/api/proxy` on the Next.js server; that proxy and the signed header it sent are
both gone, and a desktop client has no server of ours to route through — it presents a bearer token
from the machine it runs on.

Everything else the process serves stays unreachable *because the ingress does not route it*, which
is the only control in front of it:

| path | why it must not be published |
|---|---|
| `/metrics` | Prometheus, unauthenticated: request counts, queue depth, wallet activity |
| `/health` | names the model backend, the model and free GPU memory |
| `/docs`, `/openapi.json`, `/redoc` | FastAPI's generated explorer and the whole surface |

`tests/test_deploy_manifests.py` asserts the exact prefix, the `Prefix` path type, that the host
starts with `api.`, that every routed host appears in the TLS list, and that no ingress backend
names a Service the kustomization does not contain. Seven mutations of these manifests were applied
locally and each failed the suite.

**Two things have to agree with this host, and neither is in this directory.** The desktop app is
built with `VOIDCODE_BUILD_API_URL=https://api.<domain>/v1` (an Actions variable, see
`.github/workflows/desktop.yml`), and a packaged build ignores any runtime override — so a wrong
value ships in the binary. And `APP_BASE_URL` in the ConfigMap is the *website's* origin, not this
one: it is what Stripe returns a buyer to.

**A host missing from the TLS list fails differently for the two clients.** A browser warns and a
human clicks through; the desktop app refuses the connection before sending a request, and the
person sees "could not reach VoidCode" with nothing in any log.

**Migrations are an initContainer, not the entrypoint.** Two replicas starting together would race on
the alembic version table. A Job would not be ordered against the rollout, so pods could serve
against the old schema.

**The HPA scales on CPU, not memory.** A Python process's RSS does not fall when load does, so a
memory-driven HPA scales up and then never scales back down.

**`proxy-buffering: off`.** The chat stream sends incrementally. An ingress that buffers makes the
tutor appear to hang for a whole generation and then dump its answer at once. This still matters
for the desktop app's streaming, which reaches the API directly.

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
