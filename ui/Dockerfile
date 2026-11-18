# The app image: Node builds ui/app, and Caddy serves the build with the
# allow-list in ui/Caddyfile. The host needs only Docker.
#
# The build context is ui/. Only the files that the build reads are copied,
# so a node_modules folder on the host never enters the image.

FROM node:24-alpine AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/index.html app/vite.config.ts app/tsconfig.json app/tsconfig.app.json app/tsconfig.node.json ./
COPY app/public ./public
COPY app/src ./src
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv/app
COPY Caddyfile /etc/caddy/Caddyfile
