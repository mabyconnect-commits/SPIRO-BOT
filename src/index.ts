import AlphaHunterBot from './bot/telegramBot';
import tokenScanner from './scanner/tokenScanner';
import logger from './utils/logger';
import { config } from './config';
import { pipeline } from './integration/pipelineIntegration';
import { simulationEngine } from './simulation/simulationEngine';
import { strategyEngine } from './strategy/strategyEngine';
import { riskManager } from './risk/riskManager';
import { analyticsEngine } from './analytics/analyticsEngine';
import { mlEngine } from './ml/mlStrategyEngine';
import http from 'http';
import fs from 'fs';
import path from 'path';

// PID file to prevent multiple instances
const PID_FILE = path.join(__dirname, '..', 'data', 'bot.pid');

function checkAndWritePid(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
      if (oldPid && !isNaN(oldPid)) {
        try {
          // Check if old process is still alive
          process.kill(oldPid, 0);
          // It's alive — kill it
          logger.info(`Killing old bot instance (PID ${oldPid})...`);
          process.kill(oldPid, 'SIGKILL');
        } catch {
          // Process doesn't exist — stale pid file
        }
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    logger.warn('Could not manage PID file:', err);
  }
}

function cleanupPid(): void {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// Prevent unhandled rejections from crashing the bot
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit — keep the bot running
});

async function main() {
  try {
    // Kill any old instance before starting
    checkAndWritePid();
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
          modules: {
            scanner: tokenScanner.isActive(),
            simulation: simulationEngine.getStats().totalSimulations,
            strategies: strategyEngine.getActiveStrategies().length,
            riskManager: !riskManager.isKillSwitchActive(),
            mlEngine: (mlEngine as any).modelState?.version || 1,
          },
          timestamp: new Date().toISOString()
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`⚠️ Port ${PORT} in use, health check server skipped`);
      } else {
        logger.error('Health check server error:', err);
      }
    });
    server.listen(PORT, () => {
      logger.info(`🌐 Health check server listening on port ${PORT}`);
    });

    // Initialize ML database tables
    mlEngine.initializeDatabase();

    // Initialize bot
    const bot = new AlphaHunterBot();
    await bot.start();

    // Start pipeline integration services (simulation monitoring, strategy evolution, ML retraining)
    pipeline.startServices();

    // Start position monitoring
    setInterval(async () => {
      await tokenScanner.monitorPositions(0);
    }, 60000); // Check every minute

    logger.info('✅ Alpha Hunter is fully operational!');
    logger.info('📊 Paper trading:', config.trading.paperTrading ? 'ENABLED' : 'DISABLED');
    logger.info('🎯 Default preset:', config.trading.defaultPreset);
    logger.info('🧪 Simulation strategies:', simulationEngine.getStrategies().length);
    logger.info('🤖 Trading strategies:', strategyEngine.getActiveStrategies().length);
    logger.info('🧠 ML Model: v' + ((mlEngine as any).modelState?.version || 1));
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
function gracefulShutdown() {
  logger.info('Shutting down gracefully...');
  cleanupPid();
  tokenScanner.stop();
  pipeline.stopServices();
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
