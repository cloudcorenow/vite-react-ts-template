# Stage 1: Build the Vite app
FROM node:18-alpine AS build

WORKDIR /app

# Copy and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy rest of the app
COPY . .

# Build the Vite app
RUN npm run build

# Stage 2: Serve the build output with a static server
FROM node:18-alpine AS production

WORKDIR /app
RUN npm install -g serve

# Copy the built app from the previous stage
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["serve", "-s", "dist", "-l", "3000"]
