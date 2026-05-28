const Order = require('../models/Order');
const User = require('../models/User');
const { getSetting, setSetting } = require('../models/Setting');
const { notifyCustomer } = require('../services/notificationService');
const logger = require('../utils/logger');

const acctStart = async (ctx) => {
  await ctx.reply(
    `🏦 <b>Accounting Bot</b>\n\n` +
    `Available commands:\n\n` +
    `<b>/track ORDER_ID URL</b>\n  Add tracking link to an order\n\n` +
    `<b>/deliver ORDER_ID</b>\n  Mark order as delivered\n\n` +
    `<b>/close [message]</b>\n  Close ordering for customers\n\n` +
    `<b>/open</b>\n  Reopen ordering\n\n` +
    `<b>/status</b>\n  Check ordering status (open/closed)`,
    { parse_mode: 'HTML' }
  );
};

const acctTrack = async (ctx) => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('Usage: /track ORDER_ID TRACKING_URL');
  const orderId = parseInt(parts[1], 10);
  const trackingLink = parts.slice(2).join(' ').trim();
  if (!orderId || !trackingLink) return ctx.reply('Usage: /track ORDER_ID TRACKING_URL');

  const order = await Order.findByPk(orderId);
  if (!order) return ctx.reply(`❌ Order #${orderId} not found.`);

  await order.update({ tracking_link: trackingLink, updated_at: new Date() });
  await ctx.reply(`✅ Tracking link saved for Order #${orderId}.`);

  try {
    const owner = await User.findByPk(order.user_id);
    if (owner) {
      await notifyCustomer(
        owner.telegram_id,
        `📬 <b>Tracking Update — Order #${orderId}</b>\n\nYour order is on its way!\n\n` +
        `<a href="${trackingLink}">🔗 Track your package</a>`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    logger.warn('Failed to notify customer of tracking:', err.message);
  }
};

const acctDeliver = async (ctx) => {
  const orderId = parseInt(ctx.message.text.split(' ')[1], 10);
  if (!orderId) return ctx.reply('Usage: /deliver ORDER_ID');

  const order = await Order.findByPk(orderId);
  if (!order) return ctx.reply(`❌ Order #${orderId} not found.`);

  await order.update({ status: 'delivered', updated_at: new Date() });
  await ctx.reply(`✅ Order #${orderId} marked as delivered.`);

  try {
    const owner = await User.findByPk(order.user_id);
    if (owner) {
      await notifyCustomer(
        owner.telegram_id,
        `🎉 <b>Order #${orderId} Delivered!</b>\n\nYour device(s) have been delivered.\n\nThank you for your order!`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    logger.warn('Failed to notify customer of delivery:', err.message);
  }
};

const acctClose = async (ctx) => {
  const msg = ctx.message.text.split(' ').slice(1).join(' ').trim() ||
    'Stores are temporarily closed. Please try again later.';

  await setSetting('orders_open', 'false');
  await setSetting('orders_closed_message', msg);

  await ctx.reply(
    `🚫 Ordering is now <b>CLOSED</b>.\n\nMessage shown to customers:\n"${msg}"`,
    { parse_mode: 'HTML' }
  );
};

const acctOpen = async (ctx) => {
  await setSetting('orders_open', 'true');
  await ctx.reply(`✅ Ordering is now <b>OPEN</b>. Customers can place orders again.`, { parse_mode: 'HTML' });
};

const acctStatus = async (ctx) => {
  const open = await getSetting('orders_open', 'true');
  const msg = await getSetting('orders_closed_message', '');

  if (open === 'true') {
    await ctx.reply('✅ Orders are currently <b>OPEN</b>.', { parse_mode: 'HTML' });
  } else {
    await ctx.reply(
      `🚫 Orders are currently <b>CLOSED</b>.\n\nMessage: "${msg}"`,
      { parse_mode: 'HTML' }
    );
  }
};

module.exports = { acctStart, acctTrack, acctDeliver, acctClose, acctOpen, acctStatus };
