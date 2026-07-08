# Single-service image for Railway (and any container host):
# build the client bundle, then run the game server, which serves that bundle
# plus the API and WebSocket on $PORT. See README "Deploying".

FROM node:22-slim
WORKDIR /app

# Install dependencies first (better layer caching). --include=dev is required:
# building the client needs vite/typescript and running the server needs tsx,
# all of which are devDependencies that a production install would skip.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/
RUN npm ci --include=dev

# Copy the source and build the client into packages/client/dist.
COPY . .
RUN npm run build:client

# The server reads $PORT (Railway sets it) and serves the built client + /api + /ws.
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "run", "start", "--workspace", "@highlander/server"]
