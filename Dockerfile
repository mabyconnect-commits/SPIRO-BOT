FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Create data and logs directories
RUN mkdir -p data logs

# Expose port (not strictly needed for Telegram bot, but good practice)
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
