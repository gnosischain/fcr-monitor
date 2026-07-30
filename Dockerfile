# Base image pinned by digest, not by the floating `node:22-alpine` tag, so
# rebuilding an old commit produces the same image. Bump with:
#   docker buildx imagetools inspect node:22-alpine --format '{{.Manifest.Digest}}'
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# ---------------------------------------------------------------------------
# build — compiles TypeScript. `tsc` is also the quality gate for this repo:
# strict + noUncheckedIndexedAccess, and there is no test or lint script.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# No `*` glob on the lockfile: a missing package-lock.json must fail the build
# loudly rather than silently degrade to a fresh resolver run.
COPY package.json package-lock.json ./

# `npm ci`, not `npm install`, so the build is reproducible from the lockfile.
# --ignore-scripts: no locked package has a native or optional dependency, so no
# lifecycle script is needed — and blocking them removes the largest
# supply-chain execution surface in this build.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# deps — production-only node_modules
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# No `apk add wget` and no HEALTHCHECK. Kubernetes ignores Docker's HEALTHCHECK
# entirely, so the only thing it bought was leaving an HTTP client in the runtime
# image for an attacker to use. Liveness/readiness are httpGet probes on the
# Deployment instead.

# Copies stay root-owned, so the `node` user can read the app but not modify it.
# That is what makes readOnlyRootFilesystem: true viable with no carve-out
# beyond an emptyDir at /tmp.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist

# Required: "type": "module" must be resolvable from /app for ESM to load.
COPY package.json ./

# server.ts resolves publicDir as dirname(dist/server.js)/../public -> /app/public.
# Do not change this layout without updating that.
COPY public ./public

USER node

# 3000 = dashboard + /api/* + /healthz. 9100 = /metrics only (see server.ts).
EXPOSE 3000 9100

CMD ["node", "dist/index.js"]
