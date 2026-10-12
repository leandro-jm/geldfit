# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sf/api build
RUN pnpm --filter @sf/api deploy --prod --legacy /out && cp -r apps/api/dist /out/dist

FROM node:24-alpine
ENV NODE_ENV=production TZ=America/Sao_Paulo
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data/files && chown app:app /data/files
COPY --from=build --chown=app:app /out /app
USER app
EXPOSE 4100
CMD ["node", "dist/main.js"]
