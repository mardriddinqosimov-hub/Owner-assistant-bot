require('dotenv').config();
const { Telegraf } = require('telegraf');
const logger = require('./utils/logger');
const database = require('./config/database');
const Order = require('./models/Order');
const commandHandlers = require('./handlers/commandHandlers');
const callbackHandlers = require('./handlers/callbackHandlers');
const messageHandlers = require('./handlers/messageHandlers');

const User = require('./models/User');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ORDER_GROUP_ID = process.env.ORDER_GROUP_ID || '-5129310180';

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

// Admin commands — only accepted from the order group
bot.command('track', async (ctx) => {
  if (String(ctx.chat.id) !== ORDER_GROUP_ID) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('Usage: /track ORDER_ID TRACKING_URL');
  const orderId = parseInt(parts[1], 10);
  const trackingLink = parts.slice(2).join(' ').trim();
  if (!orderId || !trackingLink) return ctx.reply('Usage: /track ORDER_ID TRACKING_URL');
  const order = await Order.findByPk(orderId);
  if (!order) return ctx.reply(`Order #${orderId} not found.`);
  await order.update({ tracking_link: trackingLink, updated_at: new Date() });
  await ctx.reply(`✅ Tracking link added to Order #${orderId}.`);
  try {
    const owner = await User.findByPk(order.user_id);
    if (owner) {
      await bot.telegram.sendMessage(
        owner.telegram_id,
        `📬 <b>Tracking Update — Order #${orderId}</b>\n\nYour order is on its way!\n\n` +
        `<a href="${trackingLink}">🔗 Track your package</a>`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (_) {}
});

bot.command('deliver', async (ctx) => {
  if (String(ctx.chat.id) !== ORDER_GROUP_ID) return;
  const orderId = parseInt(ctx.message.text.split(' ')[1], 10);
  if (!orderId) return ctx.reply('Usage: /deliver ORDER_ID');
  const order = await Order.findByPk(orderId);
  if (!order) return ctx.reply(`Order #${orderId} not found.`);
  await order.update({ status: 'delivered', updated_at: new Date() });
  await ctx.reply(`✅ Order #${orderId} marked as delivered.`);
  try {
    const owner = await User.findByPk(order.user_id);
    if (owner) {
      await bot.telegram.sendMessage(
        owner.telegram_id,
        `🎉 <b>Order #${orderId} Delivered!</b>\n\nYour PT30 device(s) have been delivered.\n\nThank you for your order!`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (_) {}
});

// ─── Driver callbacks ────────────────────────────────────────────────────────
bot.action(/^driver_details_(.+)$/, callbackHandlers.driverDetails);
bot.action(/^driver_refresh_(.+)$/, callbackHandlers.driverRefresh);
bot.action(/^driver_location_(.+)$/, callbackHandlers.driverLocation);
bot.action('drivers_list', callbackHandlers.driversList);
bot.action('drivers_list_refresh', callbackHandlers.driversListRefresh);

// ─── Order callbacks ─────────────────────────────────────────────────────────
bot.action('order_devices_start', callbackHandlers.orderStart);
bot.action('order_new', callbackHandlers.orderNew);
bot.action(/^order_qty_(.+)$/, callbackHandlers.orderQuantity);
bot.action(/^order_ship_(standard|overnight)_(\d+)$/, callbackHandlers.orderShipping);
bot.action('order_confirm', callbackHandlers.orderConfirm);
bot.action('order_edit', callbackHandlers.orderEdit);
bot.action('order_cancel', callbackHandlers.orderCancel);
bot.action('order_active', callbackHandlers.orderActive);
bot.action(/^order_history_(\d+)$/, callbackHandlers.orderHistory);
bot.action(/^order_detail_(\d+)$/, callbackHandlers.orderDetail);

// ─── DOT Inspection callbacks ─────────────────────────────────────────────────
bot.action('dot_menu', callbackHandlers.dotMenu);
bot.action(/^dot_detail_(\d+)$/, callbackHandlers.dotDetail);

// ─── Menu callbacks ──────────────────────────────────────────────────────────
bot.action('main_menu', callbackHandlers.mainMenu);
bot.action('change_team', callbackHandlers.changeTeam);
bot.action('help_menu', callbackHandlers.helpMenu);

// ─── Messages ────────────────────────────────────────────────────────────────
bot.on('text', messageHandlers.handleText);
bot.on('photo', messageHandlers.handlePhoto);
bot.on('document', messageHandlers.handleDocument);

// ─── DOT Inspection polling (every 10 minutes) ────────────────────────────────
function startInspectionPolling() {
  const INTERVAL = 10 * 60 * 1000;
  const run = () => commandHandlers.checkNewInspections(bot).catch(e => logger.warn('Inspection poll error:', e.message));
  setInterval(run, INTERVAL);
  logger.info('✅ DOT inspection polling started (10 min interval)');
}

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
      app.listen(PORT, () => logger.info(`✅ Webhook server listening on port ${PORT}`));

      await bot.telegram.setWebhook(webhookUrl);
      logger.info(`✅ Webhook set: ${webhookUrl}`);
    } else {
      await bot.telegram.deleteWebhook();
      bot.launch();
      logger.info('✅ Bot polling started');
    }

    startInspectionPolling();
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
