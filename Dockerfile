FROM node:18-slim

# Install Python, pip, curl, and yt-dlp
RUN apt-get update && apt-get install -y python3 python3-pip curl unzip && \
    pip3 install yt-dlp --break-system-packages

# Install Deno (needed by yt-dlp to solve YouTube's JS signature challenges)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY index.js ./
COPY cookies.txt ./
EXPOSE 3000
CMD ["node", "index.js"]