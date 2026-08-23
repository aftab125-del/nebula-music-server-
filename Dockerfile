FROM node:22-slim

# Install Python, pip, curl and other required utilities
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install current yt-dlp with its default dependencies
RUN pip3 install --no-cache-dir -U "yt-dlp[default]" --break-system-packages

# Install Deno for yt-dlp YouTube JavaScript challenge solving
RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

WORKDIR /app

# Install Node dependencies first for better Docker layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY index.js ./

# Render provides PORT dynamically
EXPOSE 3000

CMD ["node", "index.js"]
