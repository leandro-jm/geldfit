# syntax=docker/dockerfile:1.7
# Build com o contexto na raiz do monorepo:  docker build -f apps/web/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /repo
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter @sf/web...
RUN pnpm --filter @sf/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
