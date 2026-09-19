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
| all seven routes — `/`, `/pricing`, `/download`, `/terms`, `/privacy`, `/purchase/success`, `/purchase/cancelled` | 200, real content. Re-measured after `/pricing` and `/download` were split out of the overview; the first run predated both |
| Docker `HEALTHCHECK` | **`unhealthy`, and that was the finding.** It probed `/login`, deleted with the logged-in UI, so the container reported unhealthy from its first check while serving every page correctly. Fixed to `/`. The same path was in all three Kubernetes probes below, where a startup probe that never succeeds means the pod restarts forever — so the site would never have served a request. Now checked by `tests/test_marketing_pages.py` and `apps/api/tests/test_deploy_manifests.py` |
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

## The one thing these manifests cannot start, and why flipping a flag will not fix it

**`voidcode-api:latest` cannot serve inference on this Deployment, and the reason is the image
rather than the configuration.** Recorded here rather than fixed, because the fix is a decision
about where inference runs and that is not a manifest edit.

Three requirement files, three mutually exclusive inference paths, and the API picks between them
with two flags that both default to false:

| Image | requirements | torch | openai | The only path it can run |
|---|---|---|---|---|
| **`voidcode-api:latest`** — what `containers.yml` builds and what `api-deployment.yaml` deploys | `requirements.txt` | yes | **no** | in-process HuggingFace, which needs a GPU in the same process |
| `Dockerfile.sglang` — built by nothing | `requirements.sglang.txt` | **no** | yes | SGLang, over HTTP to a separate server. CPU-only by design |
| `Dockerfile.gpu` — built by nothing | `requirements.gpu.txt` | yes | — | vLLM in-process |

The Deployment requests `cpu: "2", memory: 2Gi` and **no GPU**, and the ConfigMap sets neither
`USE_SGLANG` nor `USE_VLLM`. So the container takes the default in-process path and exits during
startup with `CUDA is not available and the in-process HuggingFace path requires a GPU`, which is
now a message that names the choice rather than the `AttributeError` it used to raise on an image
without torch.

**Setting `USE_SGLANG=true` here would replace that with `ModuleNotFoundError: No module named
'openai'`** — verified, not reasoned about — because `requirements.txt` does not carry the SGLang
client. The flag and the image have to agree, and today only one combination of them exists in CI.

Three ways out, and they are not equivalent:

1. **Build and deploy the SGLang image**, set `USE_SGLANG=true` and `SGLANG_BASE_URL`, and run an
   sglang server. Nothing in `deploy/` provides that server, in the same way nothing here provides
   Judge0 or Postgres — it would be another out-of-band dependency, and the API pod stays small.
2. **Give this Deployment a GPU** and keep the default path. The image already has torch, so this
   is a node-pool and `nvidia.com/gpu` question rather than a code one.
3. **Deploy the API without inference at all** — everything else it serves (auth, credits, the paper
   library, problems) needs no model. That needs a decision about what a request to the tutor
   should then answer, and it is the option that most needs saying out loud rather than arriving by
   default.

**`/health` can see a dead backend, and this paragraph used to say it could not.** That was wrong
and is corrected here rather than quietly deleted, because a false claim about a health endpoint is
the kind of thing the next person plans around. What `/health` actually reports:

- `model_loaded` comes from `_is_model_ready()`, which **asks the backend** — a cached `GET /models`
  through `backend_registry.probe()`, not a check that a Python client object was constructed. Its
  docstring records the defect it was written to fix: *"Point the config at a dead address and
  `/health` reported `model_loaded: true`, to a readiness probe, to a load balancer, and to whoever
  was trying to work out why every request was failing."*
- `backendState` is `ready`, `waking` or `down`, which separates a deliberate restart from an
  outage — identical from outside, opposite reactions. It is `null` when `USE_SGLANG` is
  unset, because on the in-process paths there is no backend to be unreachable: readiness there
  is "is a model object loaded", which `model_loaded` already answers. The new metric series is
  absent on those paths for the same reason.
- `base_model` is asked of the backend rather than read from config, because this endpoint once
  reported a 7B while a 30B answered every request.

What is true is narrower: the top-level `status` is computed from Postgres, Redis and Judge0 only,
so a pod with a dead backend reports `status: "healthy"` with `model_loaded: false` two lines below
it. That is deliberate and should stay — a `httpGet` probe reads the status code and never the body,
so folding the backend into `status` would not change the probe's verdict, while folding it into the
*code* would let a backend blip remove every API pod from the Service and take auth, credits and the
paper library down with it.

The gap that was real: **none of it reached Prometheus.** `/health` is polled by the kubelet and
scraped by nothing, so an operator could not alert on "the backend has been unreachable for five
minutes". `voidcode_inference_backend_state{state=...}` now carries it, set from inside `probe()`
where the state is decided, and the Grafana dashboard has a panel for it.

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
