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
#
# ONE WORKSPACE PACKAGE, not two. `packages/shared/package.json` was copied here as well until
# `@voidcode/shared` was deleted — a set of types (`ApiResponse<T>`, `PaginatedResponse`, a `User`
# with `createdAt`/`updatedAt`) that nothing ever imported and that never matched what the API
# returns. A `COPY` of a path that no longer exists fails the build, so this line went with it;
# `tests/test_marketing_pages.py` now checks that every manifest copied here is one that exists.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/

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
# runtime. So anything the browser needs has to be a build argument: setting it as an
# env var on the running container does nothing, which is a genuinely confusing failure
# — the app builds, starts, and behaves as if the value were empty.
#
# NO SECRET IS EVER AN ARG HERE, and now there is none to pass anyway: this image serves
# four static pages with no session and no API calls. It used to take the API's URL and
# read INTERNAL_API_SECRET at runtime for the proxy that signed identity headers; both
# went with the logged-in UI.
# `owner/name` of the repository whose releases the download section lists. Inlined into the
# bundle by Next at build time, like every NEXT_PUBLIC_* value, so it cannot be set at runtime.
# Empty builds a page that says no release has been published — which is correct until one is.
# ONE PER PLATFORM. `NEXT_PUBLIC_RELEASES_REPO` was a single value here; the installers are now
# published to two repositories, one per operating system, and the download section reads them
# independently so a rate-limited feed for one platform cannot hide the other's installer.
#
# The old single name is GONE rather than kept as a fallback. A deployment that set only the old
# name would look configured and serve Windows visitors macOS disk images.
#
# Empty is still a valid value for both: the section then says no release has been published rather
# than drawing a dead button.
ARG NEXT_PUBLIC_RELEASES_REPO_MAC=
ENV NEXT_PUBLIC_RELEASES_REPO_MAC=$NEXT_PUBLIC_RELEASES_REPO_MAC
ARG NEXT_PUBLIC_RELEASES_REPO_WIN=
ENV NEXT_PUBLIC_RELEASES_REPO_WIN=$NEXT_PUBLIC_RELEASES_REPO_WIN
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
# `/`, not `/login`. This probed `/login` until that route was deleted with the logged-in UI, so
# the container reported `unhealthy` from its first check onwards while serving every page
# correctly — measured rather than reasoned about: `docker run` then `docker ps` said
# `(unhealthy)` while curl returned 200 on all seven routes. `deploy/base/web-deployment.yaml` had
# the same path in all three of its Kubernetes probes, where the consequence was worse: the startup
# probe never succeeds, so the pod is killed and restarted forever and the site never serves.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
