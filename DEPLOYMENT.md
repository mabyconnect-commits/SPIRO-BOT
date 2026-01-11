# 🚀 Alpha Hunter Deployment Guide

Your bot is fully configured and ready to deploy! Choose the method that works best for you.

## ⚡ Quick Start - Local Deployment (5 minutes)

Perfect for testing or running on your personal computer.

### Prerequisites
- Node.js 18+ ([download here](https://nodejs.org/))
- Git

### Steps

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd SPIRO-BOT
git checkout claude/implement-feature-mk9hzl1800xq0a32-SOxwb

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Start (your .env is already configured!)
npm start
```

✅ **Done!** Your bot is running. Message it on Telegram!

### Keep It Running
- **Simple:** Just leave the terminal open
- **Background (Linux/Mac):** `nohup npm start > bot.log 2>&1 &`
- **Background (Windows):** Use Windows Task Scheduler or `pm2` (see below)

---

## 🌐 Cloud Deployment Options

### Option 1: Railway (Recommended - Free Tier)

**Pros:** Easy, free tier, 24/7 uptime, auto-restarts

1. Go to [railway.app](https://railway.app) and sign up
2. Click **"New Project" → "Deploy from GitHub repo"**
3. Select your SPIRO-BOT repository
4. Add environment variables from your `.env` file:
   - Click on service → **Variables** tab
   - Copy all variables from `.env` (except comments)
5. Railway auto-deploys!

**View logs:** Click on your service → Deployments → View logs

---

### Option 2: Render (Free Alternative)

**Pros:** Also free, similar to Railway

1. Go to [render.com](https://render.com) and sign up
2. **New → Web Service**
3. Connect your GitHub repo
4. Configure:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
5. Add environment variables from `.env`
6. Click **Deploy**

---

### Option 3: DigitalOcean / AWS / VPS

**Pros:** Full control, can run other services too

#### SSH into your server:
```bash
ssh root@your-server-ip
```

#### Install Node.js:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs git
```

#### Deploy your bot:
```bash
git clone <your-repo-url>
cd SPIRO-BOT
git checkout claude/implement-feature-mk9hzl1800xq0a32-SOxwb
npm install
npm run build
```

#### Create .env file:
```bash
nano .env
# Paste your environment variables
# Save with Ctrl+X, Y, Enter
```

#### Install PM2 (process manager):
```bash
npm install -g pm2
pm2 start npm --name "alpha-hunter" -- start
pm2 save
pm2 startup
```

**Useful PM2 commands:**
```bash
pm2 status          # Check status
pm2 logs            # View logs
pm2 restart alpha-hunter
pm2 stop alpha-hunter
pm2 delete alpha-hunter
```

---

## 🐳 Docker Deployment

**Pros:** Works anywhere, easy to update, isolated environment

### Using Docker Compose (Easiest):

```bash
# 1. Make sure Docker is installed
# Download from: https://docs.docker.com/get-docker/

# 2. Build and start
docker-compose up -d

# 3. View logs
docker-compose logs -f

# 4. Stop
docker-compose down
```

### Using Docker CLI:

```bash
# Build image
docker build -t alpha-hunter .

# Run container
docker run -d \
  --name alpha-hunter \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  --restart unless-stopped \
  alpha-hunter

# View logs
docker logs -f alpha-hunter

# Stop
docker stop alpha-hunter
docker rm alpha-hunter
```

---

## 📱 Testing Your Bot

Once deployed, test your bot:

1. **Find your bot on Telegram** (search for the username you set with @BotFather)
2. **Send:** `/start`
3. **Try pasting a Solana contract address** (e.g., any popular token)
4. **Test commands:**
   - `/hunt` - Start scanning
   - `/portfolio` - View positions
   - `/patterns` - See AI learning stats
   - `/preset balanced` - Change settings

---

## 🔧 Troubleshooting

### Bot not responding?
1. Check logs for errors
2. Verify `TELEGRAM_BOT_TOKEN` is correct
3. Ensure network connectivity (bot needs internet)
4. Check if process is running

### "Polling error" or connection issues?
- Check your firewall settings
- Verify environment variables are set
- Try restarting the bot

### Database errors?
- Make sure `data/` directory exists and is writable
- Check `DB_PATH` in `.env`

### Memory issues on free tier?
- Railway/Render free tiers have 512MB RAM
- Bot uses ~100-200MB normally
- Reduce `SCAN_INTERVAL_MS` if needed

---

## 🔐 Security Best Practices

### Never commit these files:
- ✅ `.env` is in `.gitignore` (your secrets are safe)
- ✅ `data/` and `logs/` are ignored

### For production:
1. **Keep `.env` secure** - Never share it
2. **For real trading:** Add your `SOLANA_WALLET_PRIVATE_KEY` carefully
3. **Start with paper trading:** Test first with `PAPER_TRADING=true`
4. **Monitor your bot:** Check logs regularly
5. **Update dependencies:** Run `npm audit fix` periodically

---

## 🔄 Updating Your Bot

### Local/VPS:
```bash
git pull origin claude/implement-feature-mk9hzl1800xq0a32-SOxwb
npm install
npm run build
# Restart (method depends on how you're running it)
```

### Railway/Render:
Just push to GitHub - auto-deploys!

### Docker:
```bash
docker-compose down
git pull
docker-compose up -d --build
```

---

## 📊 Monitoring

### Check if bot is running:
```bash
# Local with PM2:
pm2 status

# Docker:
docker ps

# Check process:
ps aux | grep node
```

### View logs:
```bash
# Local:
tail -f logs/alpha-hunter.log

# PM2:
pm2 logs alpha-hunter

# Docker:
docker logs -f alpha-hunter

# Railway/Render:
View in web dashboard
```

---

## 💡 Pro Tips

1. **Start with paper trading** - Test everything before risking real funds
2. **Monitor first 24 hours** - Check logs for any issues
3. **Use Helius RPC** - Better performance (you already have this!)
4. **Add Birdeye API** - Get security checks (optional but recommended)
5. **Join Telegram** - You can control your bot from anywhere!

---

## 🆘 Need Help?

- Check logs first: `logs/alpha-hunter.log`
- Verify all environment variables are set correctly
- Test with `/start` command on Telegram
- Make sure your server/computer has internet access

---

**Your bot is ready to hunt! 🎯🚀**
