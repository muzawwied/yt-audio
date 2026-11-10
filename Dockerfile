FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get clean

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
