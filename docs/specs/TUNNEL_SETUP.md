# Sharing Your Local App via Cloudflare Tunnels

## Architecture

```
External Users (browser)
    │
    ├──► https://xxxxx.trycloudflare.com  ──► Your PC: Next.js (:3000)
    │                                              │
    └──► https://yyyyy.trycloudflare.com  ──► Your PC: FastAPI (:8000)
                                                   │
                                                   ├── PostgreSQL (Docker :5433)
                                                   ├── Redis      (Docker :6380)
                                                   └── Judge0     (Docker :2358)
```

**Key point:** PostgreSQL, Redis, and Judge0 run locally in Docker.
The backend connects to them over `localhost`. External users never
access the databases directly — they only talk to your API through
the Cloudflare tunnel. This is secure and works perfectly.

---

## Prerequisites

1. **Docker Desktop** — [docker.com/get-started](https://www.docker.com/get-started/)
2. **cloudflared** — Install via:
   ```bash
   # Windows (winget)
   winget install Cloudflare.cloudflared

   # Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   ```
3. **Node.js + pnpm** (already installed)
4. **Python 3.11+** (already installed)

---

## Step-by-Step

### 1. Start Docker Services

```bash
# From project root
docker compose up -d

# Verify everything is healthy
docker compose ps
```

You should see `voidcode-postgres`, `voidcode-redis`, and
`voidcode-judge0` all running.

### 2. Run Database Migrations

```bash
cd apps/api
alembic upgrade head
```

### 3. Start the Backend (Docker GPU)

```bash
# From project root — starts vLLM API + Postgres + Redis + Judge0
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

# Verify healthy (wait ~60s for vLLM engine to warm up)
docker compose -f docker-compose.yml -f docker-compose.gpu.yml ps
curl http://localhost:8000/health
```

### 4. Start the Cloudflare Tunnels

**Quick method (random URLs, no account needed):**

```bash
# Option A: Use the batch script
start-tunnels.bat

# Option B: Manual (run each in a separate terminal)
cloudflared tunnel --url http://localhost:8000    # Backend
cloudflared tunnel --url http://localhost:3000    # Frontend
```

Each tunnel prints a URL like:
```
https://example-random-words.trycloudflare.com
```

### 5. Configure the Frontend to Use the Backend Tunnel URL

Copy the **backend** tunnel URL, then edit `apps/web/.env.local`:

```env
NEXT_PUBLIC_API_URL=https://your-backend-words.trycloudflare.com
```

### 6. Start the Frontend (Next.js)

```bash
cd apps/web
pnpm dev
```

### 7. Share the Link

Give users the **frontend** tunnel URL:
```
https://your-frontend-words.trycloudflare.com
```

They can use the full app — the frontend talks to the backend
through the backend tunnel, and the backend talks to the local
Docker databases.

---

## Named Tunnel (Persistent URLs)

Free quick tunnels generate random URLs each time. For stable URLs:

1. **Create a Cloudflare account** at [dash.cloudflare.com](https://dash.cloudflare.com)
2. **Authenticate:** `cloudflared tunnel login`
3. **Create tunnel:** `cloudflared tunnel create voidcode-ai`
4. **Edit `tunnel-config.yml`** — replace `<TUNNEL_ID>` and hostnames
5. **Add DNS records:**
   ```bash
   cloudflared tunnel route dns voidcode-ai voidcode-ai.your-domain.com
   cloudflared tunnel route dns voidcode-ai voidcode-api.your-domain.com
   ```
6. **Run:** `cloudflared tunnel --config tunnel-config.yml run`

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `cloudflared` not found | Install it: `winget install Cloudflare.cloudflared` |
| Frontend can't reach backend | Check `NEXT_PUBLIC_API_URL` in `.env.local` matches the backend tunnel URL. Restart `pnpm dev` after changing it |
| CORS errors | Already handled — `main.py` allows `*.trycloudflare.com` origins |
| Database connection refused | Run `docker compose up -d` and check `docker compose ps` |
| Judge0 not working | Judge0 needs `privileged: true` in Docker. On Windows, ensure WSL2 backend is enabled in Docker Desktop |
| Tunnel drops after closing terminal | Keep the `cloudflared` terminal open, or use a named tunnel with a system service |
