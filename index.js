require('dotenv').config();
const { Telegraf } = require('telegraf');
const logger = require('./utils/logger');
const database = require('./config/database');
const { Setting } = require('./models/Setting');
const Order = require('./models/Order');
const User = require('./models/User');
const commandHandlers = require('./handlers/commandHandlers');
const callbackHandlers = require('./handlers/callbackHandlers');
const messageHandlers = require('./handlers/messageHandlers');
const accountingHandlers = require('./handlers/accountingHandlers');
const notifService = require('./services/notificationService');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ORDER_GROUP_ID = process.env.ORDER_GROUP_ID || '-5129310180';
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';

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

// ─── Main bot commands ────────────────────────────────────────────────────────
bot.start(commandHandlers.start);
bot.command('drivers', commandHandlers.drivers);
bot.command('help', commandHandlers.help);
bot.command('setapi', commandHandlers.setapi);
bot.command('orders', commandHandlers.orders);

// ─── Driver callbacks ─────────────────────────────────────────────────────────
bot.action(/^driver_details_(.+)$/, callbackHandlers.driverDetails);
bot.action(/^driver_refresh_(.+)$/, callbackHandlers.driverRefresh);
bot.action(/^driver_location_(.+)$/, callbackHandlers.driverLocation);
bot.action('drivers_list', callbackHandlers.driversList);
bot.action('drivers_list_refresh', callbackHandlers.driversListRefresh);

// ─── Order submenu ────────────────────────────────────────────────────────────
bot.action('order_devices_start', callbackHandlers.orderStart);
bot.action('order_new', callbackHandlers.orderNew);

// Full Set flow
bot.action('order_fullset', callbackHandlers.orderFullSet);
bot.action(/^fs_cable_(vm|obd|rp|p9)$/, callbackHandlers.fsSelectCable);
bot.action(/^fs_cnt_(\d+)$/, callbackHandlers.fsSelectCount);
bot.action(/^fs_shp_(s|o)$/, callbackHandlers.fsSelectShipping);

// Custom cart flow
bot.action('order_custom', callbackHandlers.orderCustom);
bot.action(/^cu_item_(pt30|vm|obd|rp|p9)$/, callbackHandlers.cuSelectItem);
bot.action(/^cu_qty_(pt30|vm|obd|rp|p9)_(\d+)$/, callbackHandlers.cuSetQty);
bot.action('cu_shipping', callbackHandlers.cuShowShipping);
bot.action(/^cu_ship_(s|o)$/, callbackHandlers.cuSelectShipping);

// Order management
bot.action('order_confirm', callbackHandlers.orderConfirm);
bot.action('order_edit', callbackHandlers.orderEdit);
bot.action('order_cancel', callbackHandlers.orderCancel);
bot.action('order_active', callbackHandlers.orderActive);
bot.action(/^order_history_(\d+)$/, callbackHandlers.orderHistory);
bot.action(/^order_detail_(\d+)$/, callbackHandlers.orderDetail);

// ─── Platform selection ───────────────────────────────────────────────────────
bot.action(/^platform_select_(leader|factor)$/, callbackHandlers.selectPlatform);

// ─── DOT Inspection callbacks ─────────────────────────────────────────────────
bot.action('dot_menu', callbackHandlers.dotMenu);
bot.action(/^dot_detail_(\d+)$/, callbackHandlers.dotDetail);

// ─── Menu callbacks ───────────────────────────────────────────────────────────
bot.action('main_menu', callbackHandlers.mainMenu);
bot.action('change_team', callbackHandlers.changeTeam);
bot.action('help_menu', callbackHandlers.helpMenu);

// ─── Messages ─────────────────────────────────────────────────────────────────
bot.on('text', messageHandlers.handleText);
bot.on('photo', messageHandlers.handlePhoto);
bot.on('document', messageHandlers.handleDocument);

// ─── Accounting bot ───────────────────────────────────────────────────────────
let accountingBot = null;

function setupAccountingBot() {
  if (!process.env.ACCOUNTING_BOT_TOKEN) {
    logger.warn('ACCOUNTING_BOT_TOKEN not set — accounting bot disabled');
    return;
  }

  accountingBot = new Telegraf(process.env.ACCOUNTING_BOT_TOKEN);

  // Only allow the designated admin
  accountingBot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== String(ADMIN_ID)) return;
    return next();
  });

  accountingBot.command('start', accountingHandlers.acctStart);
  accountingBot.command('track', accountingHandlers.acctTrack);
  accountingBot.command('deliver', accountingHandlers.acctDeliver);
  accountingBot.command('close', accountingHandlers.acctClose);
  accountingBot.command('open', accountingHandlers.acctOpen);
  accountingBot.command('status', accountingHandlers.acctStatus);

  // Main nav
  accountingBot.action('acct_main_menu', accountingHandlers.acctMainMenu);

  // Active orders
  accountingBot.action('acct_active_orders', accountingHandlers.acctActiveOrders);
  accountingBot.action(/^acct_order_(\d+)$/, accountingHandlers.acctOrderDetail);
  accountingBot.action(/^acct_add_track_(\d+)$/, accountingHandlers.acctAddTrackingStart);
  accountingBot.action(/^acct_deliver_cb_(\d+)$/, accountingHandlers.acctDeliverCb);

  // Order management
  accountingBot.action('acct_management', accountingHandlers.acctManagement);
  accountingBot.action('acct_close_prompt', accountingHandlers.acctClosePrompt);
  accountingBot.action('acct_close_default', accountingHandlers.acctCloseDefault);
  accountingBot.action('acct_open', accountingHandlers.acctOpenCb);
  accountingBot.action('acct_status', accountingHandlers.acctStatusCb);

  // Order history
  accountingBot.action('acct_history', accountingHandlers.acctHistory);
  accountingBot.action(/^acct_history_order_(\d+)$/, accountingHandlers.acctHistoryOrder);

  accountingBot.on('text', accountingHandlers.acctHandleText);
}

// ─── DOT inspection polling (every 10 min) ────────────────────────────────────
function startInspectionPolling() {
  const INTERVAL = 10 * 60 * 1000;
  const run = () => commandHandlers.checkNewInspections(bot).catch(e => logger.warn('Inspection poll error:', e.message));
  setInterval(run, INTERVAL);
  logger.info('✅ DOT inspection polling started (10 min interval)');
}

async function startBot() {
  try {
    await initDatabase();
    setupAccountingBot();

    // Wire notification service
    notifService.setMainBot(bot);
    if (accountingBot) notifService.setAccountingBot(accountingBot);

    if (process.env.NODE_ENV === 'production' && process.env.WEBHOOK_URL) {
      const express = require('express');
      const app = express();
      const PORT = process.env.PORT || 3000;
      const webhookPath = '/telegram';
      const webhookUrl = `${process.env.WEBHOOK_URL}${webhookPath}`;

      app.use(bot.webhookCallback(webhookPath));
      app.get('/health', (req, res) => res.json({ status: 'ok' }));
      app.listen(PORT, () => logger.info(`✅ Webhook server listening on port ${PORT}`));

      await bot.telegram.setWebhook(webhookUrl);
      logger.info(`✅ Webhook set: ${webhookUrl}`);
    } else {
      await bot.telegram.deleteWebhook();
      bot.launch();
      logger.info('✅ Main bot polling started');
    }

    // Accounting bot always uses polling (internal tool)
    if (accountingBot) {
      await accountingBot.telegram.deleteWebhook();
      accountingBot.launch();
      logger.info('✅ Accounting bot polling started');
    }

    startInspectionPolling();
    logger.info('🤖 BOT ONLINE - READY FOR COMMANDS');
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  if (accountingBot) accountingBot.stop('SIGINT');
  process.exit(0);
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  if (accountingBot) accountingBot.stop('SIGTERM');
  process.exit(0);
});

startBot();
module.exports = bot;
