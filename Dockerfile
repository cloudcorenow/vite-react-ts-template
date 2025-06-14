# Build stage
FROM node:18-alpine AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install

COPY tsconfig.json vite.config.ts* ./
COPY src ./src
COPY public ./public

RUN pnpm build

# Production stage
FROM node:18-alpine AS production

WORKDIR /app
RUN npm install -g serve

COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["serve", "-s", "dist", "-l", "3000"]
