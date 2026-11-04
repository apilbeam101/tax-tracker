# syntax=docker/dockerfile:1

# Production dependencies, installed for the TARGET platform. @node-rs/argon2 is a native addon
# that ships one prebuilt binary per platform as an optional dependency, and npm chooses it at
# install time, so this stage must run on (or emulate) the platform being built. Copying
# node_modules across from a build-host stage would put the wrong binary in the arm64 image.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Fails the build, for this platform, if the argon2 prebuilt for it is missing or does not load.
# Without it an arm64 image built under emulation would pass and only break for its users.
RUN node -e "require('@node-rs/argon2')"

# Builder: compiles the Svelte SPA and the TypeScript server. The output is architecture-independent
# JavaScript, so it runs on the build host's own platform and nothing from it ships except dist/.
FROM --platform=$BUILDPLATFORM node:26 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# .dockerignore excludes .env/data/dist -- the load-bearing control against a
# stray local secret or DB file landing in a layer, since this copies the
# whole build context.
COPY . .
RUN npm run build

# Runtime: dist/ and production dependencies only. No compiler, no source, no devDeps.
FROM node:26-slim AS runtime
WORKDIR /app

# AUTO_CONFIG=false keeps containers in env-supplied mode (secrets come from the environment or
# *_FILE paths, the app never writes configuration); the CLI that is now the entrypoint would
# otherwise default to self-configured mode. Set AUTO_CONFIG=true to opt in.
ENV NODE_ENV=production \
    AUTO_CONFIG=false
# The OS-default data directory ($HOME/.local/share) doesn't exist for the
# service user, so a bare `docker run -v vol:/app/data` must be pointed here.
ENV DATA_DIR=/app/data
ENV LOG_LEVEL=warn

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/dist ./dist

# `docker compose exec tax-tracker tax-tracker backup` and friends.
RUN chmod +x /app/dist/server/cli.js && ln -s /app/dist/server/cli.js /usr/local/bin/tax-tracker

# The build arguments come last, after the layers above, so a new commit or version does not
# invalidate them.
ARG GIT_COMMIT=unknown
ARG IMAGE_VERSION=0.0.0
ENV GIT_COMMIT=${GIT_COMMIT} \
    IMAGE_VERSION=${IMAGE_VERSION}
LABEL org.opencontainers.image.title="tax-tracker" \
      org.opencontainers.image.description="Self-hosted UK tax tracker for share purchases, dividends and disposals" \
      org.opencontainers.image.source="https://github.com/apilbeam101/tax-tracker" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

# Fixed non-zero UID/GID (not the image's default `node` user) so it's
# predictable for volume permissions. Owns /app/data up front -- this only
# actually takes effect for a fresh, empty NAMED volume (Docker copies the
# image directory's content+ownership into it on first use) or when running
# with no mount at all. A bind mount (what deploy/docker-compose.yml uses)
# is NOT re-owned by Docker -- the host directory's existing ownership
# governs, so it needs its own `chown -R 10001:10001` before first run;
# see the comment at the top of deploy/docker-compose.yml.
RUN groupadd --gid 10001 taxtracker \
    && useradd --uid 10001 --gid taxtracker --no-create-home --shell /usr/sbin/nologin taxtracker \
    && mkdir -p /app/data && chown taxtracker:taxtracker /app/data
USER 10001:10001

EXPOSE 3000

# Reads PORT so this stays correct under a non-default port. An explicit
# request timeout (not just Docker's own --timeout, which marks the check
# failed but does not reap the request) matters against a hung server that
# accepts but never responds -- a bare http.get with no timeout never fires
# its callback or 'error' handler, leaking one process per check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "\
const http=require('node:http');\
const port=process.env.PORT||'3000';\
const req=http.get({host:'127.0.0.1',port,path:'/health',timeout:3000},(res)=>process.exit(res.statusCode===200?0:1));\
req.on('timeout',()=>{req.destroy();process.exit(1)});\
req.on('error',()=>process.exit(1));\
"

# Exec form avoids a shell wrapper swallowing signals -- but a process running
# AS PID 1 has no default signal disposition at all (the kernel skips it), so
# plain `node` as PID 1 actually IGNORES SIGTERM rather than exiting on it.
# Run this with an init process in front (deploy/docker-compose.yml sets
# `init: true`, or use `docker run --init`) so SIGTERM is forwarded to node
# as a non-PID-1 process, where the normal default disposition applies.
#
# The CLI is the entrypoint and `start` its default command, so one-off commands run in the same
# image: `docker compose run --rm tax-tracker restore <file> --yes`, `... backup`, `... info`.
ENTRYPOINT ["node", "/app/dist/server/cli.js"]
CMD ["start"]
