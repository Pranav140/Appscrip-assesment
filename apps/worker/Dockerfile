FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages/ ./packages/
COPY apps/worker/ ./apps/worker/

RUN npm install
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/db
RUN npm run build --workspace=apps/worker

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3002
CMD ["node", "apps/worker/dist/index.js"]
