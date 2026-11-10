# 随口 · 手机浏览器语音聊天（零依赖 Node + ffmpeg）
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8795

# ffmpeg：浏览器录音（webm/opus、mp4/aac）统一转 16k 单声道 mp3 再送转写
RUN apk add --no-cache ffmpeg

COPY package.json server.js ./
COPY lib ./lib
COPY web ./web

RUN chown -R node:node /app
USER node

EXPOSE 8795
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8795/api/health || exit 1

CMD ["node", "server.js"]
