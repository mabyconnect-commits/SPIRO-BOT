import AlphaHunterBot from './bot/telegramBot';
import tokenScanner from './scanner/tokenScanner';
import logger from './utils/logger';
import { config } from './config';

async function main() {
  try {
    logger.info('🚀 Alpha Hunter starting up...');

    // Validate configuration
    if (!config.telegram.botToken) {
      logger.error('❌ TELEGRAM_BOT_TOKEN not configured in .env file');
      logger.error('Please copy .env.example to .env and configure your Telegram bot token');
      process.exit(1);
    }

    // Initialize bot
    const bot = new AlphaHunterBot();
    bot.start();

    // Start position monitoring
    setInterval(async () => {
      await tokenScanner.monitorPositions(0);
    }, 60000); // Check every minute

    logger.info('✅ Alpha Hunter is fully operational!');
    logger.info('📊 Paper trading:', config.trading.paperTrading ? 'ENABLED' : 'DISABLED');
    logger.info('🎯 Default preset:', config.trading.defaultPreset);
    logger.info('');
    logger.info('🤖 Send a message to your Telegram bot to start hunting!');

  } catch (error) {
    logger.error('Failed to start Alpha Hunter:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  tokenScanner.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down gracefully...');
  tokenScanner.stop();
  process.exit(0);
});

main();
