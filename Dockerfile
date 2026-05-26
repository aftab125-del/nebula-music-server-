FROM node:18-slim

RUN apt-get update && apt-get install -y python3 python3-pip curl && pip3 install yt-dlp --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
COPY cookies.txt /app/cookies.txt

EXPOSE 3000

CMD ["node", "index.js"]