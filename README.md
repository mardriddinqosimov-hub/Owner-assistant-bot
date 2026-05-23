# OWNER ASSISTANT BOT 🤖

Complete Telegram bot for ELD driver monitoring and device ordering.

## Quick Start (5 Minutes)

### 1. Install Node.js
Download from https://nodejs.org (choose LTS version)

### 2. Clone/Download this project
```bash
cd your-folder
```

### 3. Install dependencies
```bash
npm install
```

### 4. Create .env file
Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

Edit `.env` with:
- Your Telegram bot token (from BotFather)
- Database credentials
- API keys from Factor/Leader ELD

### 5. Setup Database
```bash
# Install PostgreSQL first from postgresql.org
# Then create database:

psql
CREATE DATABASE eld_bot;
\q
```

### 6. Run the bot
```bash
npm start
```

You should see:
```
✅ Database connected
✅ Bot polling started
🤖 BOT ONLINE - READY FOR COMMANDS
```

## Getting Your Bot Token (2 Minutes)

1. Open Telegram
2. Search for `@BotFather`
3. Send `/newbot`
4. Follow instructions
5. Copy your token to `.env` file

## Features Included

✅ **Driver Monitoring**
- See all drivers in real-time
- HOS hours tracking
- Current location
- Recent activities

✅ **DOT Inspection Alerts**
- Automatic notifications
- Inspection history

✅ **Device Orders**
- Order PT30 devices
- Auto pricing ($179 + $100 overnight)
- Payment tracking
- Shipment tracking

## Project Structure

```
src/
├── index.js              # Main bot file
├── config/
│   └── database.js       # Database setup
├── models/               # Database models
│   ├── User.js
│   ├── Driver.js
│   ├── Order.js
│   └── DOTInspection.js
├── services/             # Business logic
│   ├── UserService.js
│   ├── DriverService.js
│   ├── OrderService.js
│   ├── InspectionService.js
│   └── ELDClient.js
├── handlers/             # Command/message handlers
│   ├── commandHandlers.js
│   ├── callbackHandlers.js
│   └── messageHandlers.js
└── utils/
    └── logger.js         # Logging
```

## Environment Variables

Create `.env` file with:

```
NODE_ENV=development
TELEGRAM_BOT_TOKEN=your_token_here
DB_HOST=localhost
DB_PORT=5432
DB_NAME=eld_bot
DB_USER=postgres
DB_PASSWORD=your_password
FACTOR_ELD_API_URL=https://api.factor.eld.com
LEADER_ELD_API_URL=https://api.leader.eld.com
ENCRYPTION_KEY=your-32-char-key-here
```

## Common Commands (In Telegram)

- `/start` - Initialize bot
- `/drivers` - View all drivers
- `/setapi factor:YOUR_KEY` - Set Factor ELD API
- `/setapi leader:YOUR_KEY` - Set Leader ELD API
- `/help` - Show help
- `/orders` - View orders

## Troubleshooting

### "Cannot find module 'telegraf'"
Run: `npm install`

### "Database connection failed"
1. Make sure PostgreSQL is running
2. Check `.env` credentials
3. Create database: `CREATE DATABASE eld_bot;`

### "Invalid bot token"
1. Get new token from @BotFather
2. Update `.env` file
3. Restart bot

### "API key not working"
1. Check it's for correct ELD system (factor/leader)
2. Verify key format
3. Test API directly

## Development

### Run in development mode (auto-reload)
```bash
npm run dev
```

### Run tests
```bash
npm test
```

## Deployment

### To AWS:
1. Create EC2 instance
2. Install Node.js and PostgreSQL
3. Clone project
4. Setup `.env`
5. Run `npm start`

See deployment guide in documentation for full steps.

## Support

- Read `/help` in bot
- Check documentation PDF
- Review code comments

## Next Steps

1. ✅ Get API keys from Factor ELD & Leader ELD
2. ✅ Run bot locally
3. ✅ Test with your drivers
4. ✅ Deploy to cloud (AWS/Heroku)
5. ✅ Share with your team

---

**Ready to go!** 🚀
