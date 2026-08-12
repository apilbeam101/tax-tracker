# syntax=docker/dockerfile:1

# Builder: compiles the Svelte SPA and the TypeScript server. Nothing from
# this stage ships in the runtime image.
FROM node:24 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# .dockerignore excludes .env/data/dist -- the load-bearing control against a
# stray local secret or DB file landing in a layer, since this copies the
# whole build context.
COPY . .
RUN npm run build

# Runtime: dist/ and production dependencies only. No compiler, no source, no devDeps.
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

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
ENTRYPOINT ["node", "dist/server/main.js"]
