# apps/api — the FastAPI tier (CPU; the GPU variants are Dockerfile.gpu / .sglang).
#
# FOUR THINGS WERE WRONG WITH THIS FILE, and the first made the image undeployable:
#
#   1. It copied only `src/`, so `alembic/` and `alembic.ini` were absent and
#      MIGRATIONS COULD NOT RUN FROM THE IMAGE. Every deployment would need the
#      schema applied from somewhere else — a developer laptop, in practice.
#   2. It ran as root.
#   3. No HEALTHCHECK, so an orchestrator could not tell "started" from "serving".
#   4. `build-essential` stayed in the final image: ~200 MB of compiler that a
#      running API never uses, and a toolchain for anything that gets in.
#
# Two stages fix 4 without giving up wheels that need compiling.

# ── builder ──────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Into a virtualenv rather than the system site-packages, so the whole dependency
# set is one directory to copy across. `--no-cache-dir` keeps the wheel cache out
# of the layer.
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ── runtime ──────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# curl for the healthcheck. No compiler, no headers.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin voidcode

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# The application AND the migrations. `alembic upgrade head` reads alembic.ini,
# which resolves `script_location` relative to the working directory — so both have
# to be present and in this layout, or the entrypoint fails with a confusing
# "Path doesn't exist: alembic".
COPY --chown=voidcode:voidcode src/ ./src/
COPY --chown=voidcode:voidcode alembic/ ./alembic/
COPY --chown=voidcode:voidcode alembic.ini ./
COPY --chown=voidcode:voidcode scripts/ ./scripts/

USER voidcode
EXPOSE 8000

# `/health` rather than a TCP check: uvicorn binds the port before the lifespan has
# connected the database, so a port probe reports healthy during the window where
# every request fails. `--start-period` is generous because the lifespan may load a
# model.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

# `--proxy-headers` with `--forwarded-allow-ips` unset on purpose: `ratelimit.py`
# resolves the client IP itself from TRUSTED_PROXY_HOPS, and letting uvicorn rewrite
# `request.client` from an unvalidated X-Forwarded-For would hand the rate limiter an
# address the client chose. See ratelimit.client_ip.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
