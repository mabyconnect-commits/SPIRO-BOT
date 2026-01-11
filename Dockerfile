FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (needed for TypeScript build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Create data and logs directories
RUN mkdir -p data logs

# Expose port (not strictly needed for Telegram bot, but good practice)
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
