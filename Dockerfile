FROM node:lts-slim

# Install system dependencies (FFmpeg)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app source code (including mp4 files)
COPY . .

# Expose port from environment (default 3000)
ARG PORT
EXPOSE ${PORT:-3000}

# Start command
CMD ["npm", "run", "start"]
