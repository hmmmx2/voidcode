# apps/web — the Next.js tier.
#
# THIS FILE DID NOT EXIST. The web app was not containerised at all, which is the
# reason there was no path from this repo to a running production system: the API
# had three Dockerfiles and the tier users actually talk to had none.
#
# Three stages, because a single-stage build ships the toolchain. `deps` resolves
# pnpm, `builder` compiles, and `runner` carries only the standalone output — so
# the final image has no pnpm, no devDependencies and no source.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo

# Corepack pins pnpm to whatever packageManager says, rather than whatever is
# newest on the day of the build. A lockfile is only reproducible if the tool
# reading it is too.
RUN corepack enable

# Only the manifests, so this layer is cached until a dependency actually changes.
# Copying the whole repo first would invalidate it on every source edit and turn a
# 5-second rebuild into a 3-minute one.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# --frozen-lockfile fails rather than resolving something new. In CI a lockfile
# that silently updates means the image does not match what was tested.
RUN pnpm install --frozen-lockfile --filter @voidcode/web...

# ── builder ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .

# NEXT_PUBLIC_* values are INLINED INTO THE BUNDLE at build time, not read at
# runtime. So the API URL has to be a build argument: setting it as an env var on
# the running container does nothing, which is a genuinely confusing failure —
# the app builds, starts, and calls localhost.
#
# INTERNAL_API_SECRET is deliberately NOT here. It is read at runtime by the proxy
# route handler, and baking a secret into an image layer puts it in the registry.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @voidcode/web build

# ── runner ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root. node:alpine already ships a `node` user, so this needs no useradd —
# and running as root in a container that renders untrusted user content is a
# needless escalation path.
RUN mkdir -p /app/.next && chown -R node:node /app

# `standalone` already contains a traced node_modules and server.js. static/ and
# public/ are NOT included in it and must be copied separately — a well-known trap
# that produces a running app with no CSS and no images.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

# Hits a real route rather than TCP-accept. A Next.js server binds the port before
# it can render, so a port check reports healthy during the window where every
# request 500s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
