FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Pin config paths so they're stable across container restarts and self-updates.
# Without these, falling back to path.dirname(process.argv[1]) is correct for
# Next.js standalone (server.js lives at /app/) but ENV is belt-and-suspenders.
ENV CONFIG_PATH=/app/config/config.json
ENV SIDECAR_CONFIG_PATH=/app/config/sidecar.config.json
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Declare /app/config as a persistent volume so the agent URL (and other config)
# survives `docker rm` + `docker run`. Operators should bind a named volume:
#   docker run -d -v sound-suite-sidecar-config:/app/config -p 8098:8098 ...
# Without -v, Docker creates an anonymous volume — still preserves across
# container restarts (RestartPolicy=unless-stopped) but lost on `docker rm`.
VOLUME ["/app/config"]
EXPOSE 8098
CMD ["node", "server.js"]
