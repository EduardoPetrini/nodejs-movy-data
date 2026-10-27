# syntax=docker/dockerfile:1.7
#
# One image for every Movy process: the web console, the runner agents (and the
# runner each forks per run), and the CLI. Sharing it means a deploy cannot
# leave a runner on a different @movy/core than the web app that wrote its spec.
#
# Stages:
#   deps     store fetched from the lockfile alone, so a source edit does not
#            re-download the world
#   build    full install + `pnpm build`. Also what `migrate` and `seed` run,
#            because drizzle-kit and tsx are devDependencies
#   runtime  production dependencies + build output, non-root
#   e2e      Playwright's browser image + the build stage's workspace

ARG NODE_IMAGE=node:24-bookworm-slim
# Must equal the @playwright/test version in pnpm-lock.yaml: the image ships
# the browsers that exact release drives, and nothing else.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

FROM deps AS build
COPY . .
# --offline: everything was fetched above, so a lockfile drift fails here
# rather than quietly resolving something new inside the image.
#
# CI=true per command, not as ENV: `pnpm fetch` leaves a node_modules/.pnpm
# behind, and pnpm refuses to purge it without a TTY unless CI is set. As an
# ENV it would also reach the runtime container, where every library that
# sniffs CI would switch into CI mode.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --offline
RUN pnpm build

FROM deps AS runtime
ENV NODE_ENV=production
COPY . .
# --ignore-scripts: the only install script in the tree is web's `nuxt
# prepare`, which generates types for development. The built server in
# .output does not need it, and the drivers are pure JavaScript.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --prod --frozen-lockfile --offline --ignore-scripts
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/cli/dist apps/cli/dist
COPY --from=build /app/apps/runner/dist apps/runner/dist
COPY --from=build /app/apps/web/.output apps/web/.output
RUN mkdir -p /data/runs /app/logs && chown -R node:node /data /app/logs
USER node
EXPOSE 3000

FROM ${PLAYWRIGHT_IMAGE} AS e2e
# CI=1 here only: playwright.config.ts reads it for one retry and the GitHub
# reporter. Set on the runtime image it would also flip every library that
# sniffs CI into CI mode.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY --from=build /app /app
