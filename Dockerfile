FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3210
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Sessions and images live here; mount a volume so they survive redeploys.
RUN mkdir -p data && chown -R node:node /app
USER node

EXPOSE 3210
CMD ["node", "server/index.js"]
