FROM node:20-alpine
RUN apk add --no-cache git openssh-client
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev || true

COPY . .

ENV PORT=9041
EXPOSE 9041

LABEL com.centurylinklabs.watchtower.enable=true

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -q http://127.0.0.1:9041/api/generate || exit 1

CMD ["sh", "-c", "node server.mjs"]