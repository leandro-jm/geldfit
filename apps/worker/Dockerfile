# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sf/worker build
RUN pnpm --filter @sf/worker deploy --prod --legacy /out && cp -r apps/worker/dist /out/dist

FROM node:24-alpine
ENV NODE_ENV=production TZ=America/Sao_Paulo
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data/files && chown app:app /data/files
COPY --from=build --chown=app:app /out /app
USER app

CMD ["node", "dist/main.js"]
