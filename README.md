# 🎯 Alpha Hunter

**AI-Powered Solana Runner Detection & Trading System**

Alpha Hunter is a production-grade Solana token analysis and trading bot that uses multi-signal intelligence and machine learning to detect high-potential "runner" tokens before they explode.

## 🌟 Key Features

### 🔍 Multi-Signal Analysis
- **Wallet Tracking**: Identify smart money, whales, and known winning wallets
- **Technical Indicators**: Volume breakouts, liquidity scoring, RSI, price action
- **Fundamental Analysis**: Holder distribution, locked liquidity, dev wallet status
- **Social Signals**: Twitter mentions, influencer engagement, sentiment analysis

### 🧠 AI Pattern Learning
- **7 Pre-Built Patterns**: Smart Money Entry, Volume Breakout, Fresh Launch, etc.
- **Bayesian Confidence Scoring**: Self-improving pattern confidence
- **Anti-Drift Mechanism**: Prevents abandoning winning strategies
- **Performance Tracking**: Real-time win rates and average returns

### 💰 Advanced Trading
- **Paper Trading**: Test strategies risk-free (enabled by default)
- **Real Trading**: Jupiter integration for actual swaps
- **5 Trading Presets**: From Conservative to Degen
- **Auto-Trading**: Automated execution of high-confidence signals
- **Position Management**: Smart take-profit and stop-loss

### 📱 Telegram Interface
- **Instant Analysis**: Paste any contract address → full report
- **Hunt Mode**: Continuous scanning for runners
- **Portfolio Tracking**: Real-time PnL monitoring
- **Quick Actions**: Buy, sell, and manage positions
- **Custom Alerts**: Get notified of high-potential tokens

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm
- A Telegram account
- (Optional) Solana wallet for real trading

### Installation

```bash
# Clone or extract the project
cd alpha-hunter

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

### Configuration

Edit `.env` and add your Telegram bot token:

```env
# Required: Get from @BotFather on Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Optional: For enhanced features
HELIUS_API_KEY=your_helius_key
BIRDEYE_API_KEY=your_birdeye_key

# Trading settings
PAPER_TRADING=true
DEFAULT_PRESET=balanced
```

### Get a Telegram Bot Token

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the token and paste it in `.env`

### Run the Bot

```bash
# Build the project
npm run build

# Start Alpha Hunter
npm start

# Or run in development mode
npm run dev
```

Once running, message your Telegram bot to start hunting!

## 📖 Usage Guide

### Basic Commands

```
/start          - Initialize and see welcome message
/help           - Show all commands
/hunt           - Start auto-hunting for runners
/stop           - Stop auto-hunting
/portfolio      - View your positions
/settings       - View your settings
```

### Token Analysis

**Quick Analysis**: Just paste a contract address
```
7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

**Deep Scan**: Use the scan command
```
/scan 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

### Trading Commands

```bash
# Buy a token (default: 1 SOL)
/buy <contract_address>

# Buy with custom amount
/buy <contract_address> 2.5

# Sell a position
/sell <position_id>

# View portfolio
/portfolio
```

### Trading Presets

Switch between risk profiles:

```bash
/preset                  # Show current preset and options
/preset conservative     # Low risk (0.5 SOL, 50% TP, 15% SL)
/preset moderate        # Medium risk (1 SOL, 100% TP, 25% SL)
/preset balanced        # Default (1.5 SOL, 150% TP, 30% SL)
/preset aggressive      # High risk (2.5 SOL, 300% TP, 40% SL)
/preset degen           # YOLO mode (5 SOL, 500% TP, 50% SL)
```

### Settings

```bash
# Toggle auto-trading (execute signals automatically)
/autotrade on
/autotrade off

# Toggle paper trading mode
/papermode on    # Safe: simulated trades
/papermode off   # Real: actual trades with SOL

# View AI learning stats
/patterns        # Pattern performance
/learning        # Detailed learning report
```

## 🎯 Trading Presets Explained

| Preset | Position Size | Min Confidence | Take Profit | Stop Loss | Max Positions |
|--------|--------------|----------------|-------------|-----------|---------------|
| **Conservative** | 0.5 SOL | 85% | 50% | 15% | 3 |
| **Moderate** | 1.0 SOL | 75% | 100% | 25% | 5 |
| **Balanced** | 1.5 SOL | 65% | 150% | 30% | 7 |
| **Aggressive** | 2.5 SOL | 55% | 300% | 40% | 10 |
| **Degen** | 5.0 SOL | 45% | 500% | 50% | 15 |

## 🧩 Architecture

```
alpha-hunter/
├── src/
│   ├── analyzer/           # Token analysis engine
│   │   └── tokenAnalyzer.ts
│   ├── bot/               # Telegram bot interface
│   │   └── telegramBot.ts
│   ├── config/            # Configuration & presets
│   │   └── index.ts
│   ├── database/          # SQLite database
│   │   └── index.ts
│   ├── learning/          # Pattern learning system
│   │   └── patternLearner.ts
│   ├── scanner/           # Token scanner
│   │   └── tokenScanner.ts
│   ├── services/          # API clients
│   │   └── apiClients.ts
│   ├── trading/           # Trading engine
│   │   └── tradingEngine.ts
│   ├── types/             # TypeScript types
│   │   └── index.ts
│   ├── utils/             # Utilities
│   │   └── logger.ts
│   └── index.ts           # Main entry point
├── data/                  # Database files
├── logs/                  # Log files
└── dist/                  # Compiled JavaScript
```

## 🔌 API Integrations

### Required (Free)
- **DexScreener API**: Token data and trending pairs
- **Jupiter API**: Price quotes and swap execution

### Optional (Free Tiers Available)
- **Helius API**: Enhanced wallet and token holder data
- **Birdeye API**: Security checks and additional metrics

## 📊 Pattern Learning System

Alpha Hunter learns from every trade:

### Built-In Patterns
1. **Smart Money Entry** - Known winning wallets accumulating
2. **Volume Breakout** - Massive volume spike with momentum
3. **Fresh Launch** - New tokens with strong fundamentals
4. **Whale Accumulation** - Large holders steadily buying
5. **Social Momentum** - Viral on CT with strong community
6. **Stealth Accumulation** - Low-key buying before breakout
7. **Dev Locked** - Dev wallet & liquidity secured

### Learning Features
- **Bayesian Confidence**: Patterns improve with more data
- **Anti-Drift**: Prevents ignoring historically winning patterns
- **Performance Tracking**: Real-time win rates and returns
- **Adaptive Thresholds**: Automatically adjusts to market conditions

## 🛡️ Safety Features

### Paper Trading (Default)
- All trades are simulated by default
- Test strategies risk-free
- Every signal creates a paper trade automatically

### Real Trading Safeguards
- Position size limits
- Confidence thresholds
- Max open positions
- Automatic take-profit/stop-loss
- Transaction confirmation required

### Multi-User Support
- Individual settings per user
- Separate portfolios
- Custom presets
- Personal trading history

## 🔧 Advanced Configuration

### Environment Variables

```env
# Solana Configuration
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WALLET_PRIVATE_KEY=your_base58_private_key

# Scanner Settings
SCAN_INTERVAL_MS=60000           # How often to scan (ms)
MIN_LIQUIDITY_USD=10000          # Minimum liquidity filter
MIN_VOLUME_24H_USD=50000         # Minimum 24h volume

# Learning Settings
LEARNING_ENABLED=true
MIN_PATTERN_CONFIDENCE=0.6
ANTI_DRIFT_THRESHOLD=0.15

# Trading Limits
MAX_POSITION_SIZE_SOL=5.0
SLIPPAGE_BPS=100                 # 1% slippage tolerance

# Database & Logging
DB_PATH=./data/alpha-hunter.db
LOG_LEVEL=info
LOG_FILE=./logs/alpha-hunter.log
```

## 🚨 Important Notes

### Paper Trading
- **ENABLED BY DEFAULT** for safety
- Trades are simulated but tracked
- Perfect for testing and learning
- Disable with `/papermode off` (requires real wallet)

### Real Trading
- Requires Solana wallet private key in `.env`
- Uses actual SOL for trades
- All trades executed via Jupiter
- **USE AT YOUR OWN RISK**

### API Rate Limits
- Free tier APIs have limits
- Scanner automatically delays between requests
- Add API keys for higher limits

## 🤝 Contributing

This is a complete, production-ready system. Feel free to:
- Add new patterns
- Integrate additional data sources
- Enhance the learning algorithm
- Improve the UI/UX

## 📜 License

MIT License - Use at your own risk

## ⚠️ Disclaimer

**THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND.**

Cryptocurrency trading carries significant risk. This bot is for educational purposes. You are responsible for:
- Your own trading decisions
- Risk management
- Compliance with local regulations
- Security of your wallet and API keys

**Never invest more than you can afford to lose.**

## 🎯 Pro Tips

1. **Start with paper trading** - Learn how the system works
2. **Watch the patterns** - Use `/patterns` to see what's working
3. **Adjust your preset** - Match your risk tolerance
4. **Monitor your positions** - Check `/portfolio` regularly
5. **Trust the AI** - The learning system improves over time
6. **Set alerts** - Enable notifications for high-confidence signals
7. **Review trades** - Learn from wins and losses

## 🚀 Ready to Hunt!

Your Alpha Hunter is ready to find the next 10x-100x Solana runners.

Start by sending `/start` to your Telegram bot, or paste a contract address to analyze!

Happy hunting! 🎯🚀
