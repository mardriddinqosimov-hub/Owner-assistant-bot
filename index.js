require('dotenv').config();
const { Telegraf } = require('telegraf');
const logger = require('./utils/logger');
const database = require('./config/database');
const commandHandlers = require('./handlers/commandHandlers');
const callbackHandlers = require('./handlers/callbackHandlers');
const messageHandlers = require('./handlers/messageHandlers');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

async function initDatabase() {
  try {
    await database.authenticate();
    logger.info('✅ Database connected');
    await database.sync({ alter: true });
    logger.info('✅ Database synced');
  } catch (error) {
    logger.warn('⚠️  Database not available - bot running without DB: ' + error.message);
  }
}

bot.use(async (ctx, next) => {
  try {
    ctx.session = ctx.session || {};
    await next();
  } catch (error) {
    logger.error('Middleware error:', error);
    ctx.reply('❌ Something went wrong. Please try again.');
  }
});

// ─── Commands ────────────────────────────────────────────────────────────────
bot.start(commandHandlers.start);
bot.command('drivers', commandHandlers.drivers);
bot.command('help', commandHandlers.help);
bot.command('setapi', commandHandlers.setapi);
bot.command('orders', commandHandlers.orders);

// ─── Driver callbacks ────────────────────────────────────────────────────────
bot.action(/^driver_details_(.+)$/, callbackHandlers.driverDetails);
bot.action(/^driver_refresh_(.+)$/, callbackHandlers.driverRefresh);
bot.action(/^driver_location_(.+)$/, callbackHandlers.driverLocation);
bot.action('drivers_list', callbackHandlers.driversList);
bot.action('drivers_list_refresh', callbackHandlers.driversListRefresh);

// ─── Order callbacks ─────────────────────────────────────────────────────────
bot.action('order_devices_start', callbackHandlers.orderStart);
bot.action(/^order_qty_(.+)$/, callbackHandlers.orderQuantity);
bot.action(/^order_ship_(standard|overnight)_(\d+)$/, callbackHandlers.orderShipping);

// ─── Menu callbacks ──────────────────────────────────────────────────────────
bot.action('main_menu', callbackHandlers.mainMenu);
bot.action('change_team', callbackHandlers.changeTeam);
bot.action('help_menu', callbackHandlers.helpMenu);

// ─── Messages ────────────────────────────────────────────────────────────────
bot.on('text', messageHandlers.handleText);
bot.on('document', messageHandlers.handleDocument);

async function startBot() {
  try {
    await initDatabase();

    if (process.env.NODE_ENV === 'production' && process.env.WEBHOOK_URL) {
      const express = require('express');
      const app = express();
      const PORT = process.env.PORT || 3000;
      const webhookPath = '/telegram';
      const webhookUrl = `${process.env.WEBHOOK_URL}${webhookPath}`;

      app.use(bot.webhookCallback(webhookPath));

      app.get('/health', (req, res) => res.json({ status: 'ok' }));

      app.listen(PORT, () => {
        logger.info(`✅ Webhook server listening on port ${PORT}`);
      });

      await bot.telegram.setWebhook(webhookUrl);
      logger.info(`✅ Webhook set: ${webhookUrl}`);
    } else {
      await bot.telegram.deleteWebhook();
      bot.launch();
      logger.info('✅ Bot polling started');
    }

    logger.info('🤖 BOT ONLINE - READY FOR COMMANDS');
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

startBot();
module.exports = bot;
