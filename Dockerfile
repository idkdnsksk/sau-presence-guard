FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci
COPY backend backend
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY backend/src/public backend/src/public
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/backend
EXPOSE 8080
CMD ["node", "dist/server.js"]
