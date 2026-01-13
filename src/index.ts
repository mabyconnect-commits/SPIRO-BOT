import AlphaHunterBot from './bot/telegramBot';
import tokenScanner from './scanner/tokenScanner';
import logger from './utils/logger';
import { config } from './config';
import http from 'http';

async function main() {
  try {
    logger.info('🚀 Alpha Hunter starting up...');

    // Validate configuration
    if (!config.telegram.botToken) {
      logger.error('❌ TELEGRAM_BOT_TOKEN not configured in .env file');
      logger.error('Please copy .env.example to .env and configure your Telegram bot token');
      process.exit(1);
    }

    // Start health check server for Render
    const PORT = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          service: 'SPIRO-BOT',
          timestamp: new Date().toISOString()
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    server.listen(PORT, () => {
      logger.info(`🌐 Health check server listening on port ${PORT}`);
    });

    // Initialize bot
    const bot = new AlphaHunterBot();
    await bot.start();

    // Start position monitoring
    setInterval(async () => {
      await tokenScanner.monitorPositions(0);
    }, 60000); // Check every minute

    logger.info('✅ Alpha Hunter is fully operational!');
    logger.info('📊 Paper trading:', config.trading.paperTrading ? 'ENABLED' : 'DISABLED');
    logger.info('🎯 Default preset:', config.trading.defaultPreset);
    logger.info('');
    logger.info('🤖 Send a message to your Telegram bot to start hunting!');

    // Return server for graceful shutdown
    return server;

  } catch (error) {
    logger.error('Failed to start Alpha Hunter:', error);
    process.exit(1);
  }
}

// Start the application
let server: http.Server;
main().then((srv) => {
  if (srv) server = srv;
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  tokenScanner.stop();
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  logger.info('Shutting down gracefully...');
  tokenScanner.stop();
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});
