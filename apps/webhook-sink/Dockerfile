FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY apps/webhook-sink/ ./apps/webhook-sink/

RUN npm install
RUN npm run build --workspace=apps/webhook-sink

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3003
CMD ["node", "apps/webhook-sink/dist/index.js"]
