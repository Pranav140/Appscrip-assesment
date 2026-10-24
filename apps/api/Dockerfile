FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

RUN npm install
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/db
RUN npm run build --workspace=apps/api

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
