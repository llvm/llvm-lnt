FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci

FROM deps AS client-build
COPY client client
RUN npm run build -w client

FROM deps AS server-build
COPY server server
RUN npm run build -w server

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev -w server
COPY --from=server-build /app/server/dist server/dist
COPY --from=client-build /app/client/dist client/dist
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=5s \
  CMD wget --quiet -O - http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/dist/index.js"]
