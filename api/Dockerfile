# LIEN /api — production image. Build context is the api/ directory.
# Works on Railway, Render, Fly.io, Cloud Run, or any container host.

# --- build stage: compile TypeScript → dist/ ---
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: only prod deps + compiled output ---
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The host platform sets PORT; default to 8787 locally. Bind all interfaces.
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["node", "dist/index.js"]
