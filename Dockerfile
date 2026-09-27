FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["npm","start"]
