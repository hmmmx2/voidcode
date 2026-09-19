# Reaching a local API from somewhere else, with a Cloudflare tunnel

> **REWRITTEN.** This document described tunnelling *two* things: a Next.js app on `:3000` for users
> to visit, and the API on `:8000` for that app to call. The first no longer exists — the logged-in
> UI is the desktop application, installed rather than visited — so there is nothing to share a URL
> to. What a tunnel is still good for is the other half: giving a desktop app running on somebody
> else's machine a reachable address for **your** API, before there is a domain and a certificate.
>
> If you followed the old version and are wondering where `NEXT_PUBLIC_API_URL` and `AUTH_URL` went:
> they were read by the website's server, which no longer signs anyone in. Setting them now does
> nothing, and a stale value in `apps/web/.env.local` is the kind of thing that used to cost an
> afternoon.

## What this is for

```
Their machine: VoidCode.app ──HTTPS──► https://xxxxx.trycloudflare.com
                                                  │
                                                  ▼
                                         Your PC: the API (:8020 or :8000)
                                                  │
                                                  ├── PostgreSQL (Docker :5433)
                                                  ├── Redis      (Docker :6380)
                                                  └── Judge0     (Docker :2358)
```

**One tunnel, not two.** The desktop app is the client; there is no web front end in front of the
API any more. Postgres, Redis and Judge0 stay on `localhost` behind the API, which is the part worth
keeping about the old arrangement: whoever you share the URL with reaches `/v1` and nothing else.

**The app is not a browser, so CORS does not apply to it.** It sends a bearer token from the machine
it runs on; there is no origin, no cookie and no preflight. `config.cors_settings()` still allows
tunnel origins *in development* — with a warning logged at startup — for anything browser-based that
is still pointed at a tunnel, and allows only `ALLOWED_ORIGINS` when `APP_ENV=production`, where
empty is the correct value. See the comment above `app.add_middleware` in `apps/api/src/main.py` for
why that branch exists at all.

---

## Prerequisites

1. **Docker Desktop** — [docker.com/get-started](https://www.docker.com/get-started/)
2. **cloudflared**:
   ```bash
   # Windows (winget)
   winget install Cloudflare.cloudflared
   ```
   Or download from
   [Cloudflare's downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
3. **Python 3.11+**

---

## Step by step

### 1. Infrastructure

```bash
docker compose up -d
docker compose ps
```

`voidcode-postgres`, `voidcode-redis` and the Judge0 containers should be healthy.

### 2. Migrations

```bash
cd apps/api
alembic upgrade head
```

### 3. The API

Either path works; they publish **different ports**, which matters in step 5.

```bash
# From source, on 8020 — the port the desktop app defaults to
cd apps/api && python -m uvicorn src.main:app --port 8020

# Or the GPU container, on 8000
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
curl http://localhost:8000/health        # wait ~60s for the engine to warm up
```

### 4. One tunnel, to the API

```bash
start-tunnels.bat                                  # or, by hand:
cloudflared tunnel --url http://127.0.0.1:8020
```

It prints an address like `https://example-random-words.trycloudflare.com`. It is https, which the
app requires: `isAcceptableApiBase` in `desktop/src/main/platform/config.ts` accepts `https:`
anywhere and plain `http:` only for `127.0.0.1`, because a password and a session token travel to
this address.

### 5. Point the app at it

```bash
cd desktop
cross-env VOIDCODE_API_URL=https://example-random-words.trycloudflare.com/v1 npm run dev
```

**The `/v1` suffix is part of the address**, not something the app appends — the same base is used
for `/auth/desktop/session` and `/credits`, and the production ingress publishes only that prefix.

**A packaged build ignores this variable**, deliberately: `overridesAllowed()` is false unless the
app is unpackaged or the build set `VOIDCODE_BUILD_ALLOW_OVERRIDE=1`. An environment variable that
could redirect where a learner's password is sent is not something an installed application should
honour from whatever launched it. To hand a *packaged* build to somebody else, build it with
`VOIDCODE_BUILD_API_URL` set — see `.github/workflows/desktop.yml`.

### 6. What they get

A desktop app that can sign in, buy credits, read the research library and use the VoidCode model
against your machine. Signed out it still contacts nothing, which is the same property the shipped
app has and is worth confirming from a second machine.

---

## Named tunnel (a URL that survives a restart)

Free quick tunnels get a new random URL every time, and a dead one in a build is the failure mode
this document used to cause. For a stable address:

1. **Create a Cloudflare account** at [dash.cloudflare.com](https://dash.cloudflare.com)
2. **Authenticate:** `cloudflared tunnel login`
3. **Create the tunnel:** `cloudflared tunnel create voidcode-api`
4. **Edit [`tunnel-config.yml`](../../tunnel-config.yml)** — replace `<TUNNEL_ID>` and the hostname
5. **Add the DNS record:**
   ```bash
   cloudflared tunnel route dns voidcode-api api.your-domain.com
   ```
6. **Run:** `cloudflared tunnel --config tunnel-config.yml run`

At that point you have the shape the real deployment has —
[`deploy/base/ingress.yaml`](../../deploy/base/ingress.yaml) publishes `api.<domain>/v1` and nothing
else — and the tunnel is a stand-in for the ingress rather than a different architecture.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `cloudflared` not found | `winget install Cloudflare.cloudflared` |
| The app says VoidCode is not set up in this build | The address was rejected before any request. It must parse, be `https:` (or `http://127.0.0.1`), and carry no embedded credentials. A missing `/v1` is the other common cause |
| The app reaches the tunnel and every account call fails | Check the port the tunnel points at matches the one the API is listening on — 8020 from source, 8000 in the container |
| Nothing changes after editing the variable | A packaged build ignores `VOIDCODE_API_URL`; run from source, or bake `VOIDCODE_BUILD_API_URL` in |
| CORS errors | Not from the desktop app, which sends no origin. If a browser is involved, `APP_ENV` is what decides — see above |
| Database connection refused | `docker compose up -d`, then `docker compose ps` |
| Judge0 not working | Judge0 needs `privileged: true`; on Windows make sure Docker Desktop is on the WSL2 backend |
| Tunnel drops when the terminal closes | Keep the `cloudflared` window open, or use a named tunnel as a service |
