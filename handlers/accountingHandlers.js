const Order = require('../models/Order');
const User = require('../models/User');
const { getSetting, setSetting } = require('../models/Setting');
const { notifyCustomer } = require('../services/notificationService');
const logger = require('../utils/logger');

// Pending sessions: telegram_id → { action: 'track'|'deliver' }
const acctSessions = new Map();

const MAIN_KB = {
  inline_keyboard: [
    [
      { text: '📬 Track Order', callback_data: 'acct_track_start' },
      { text: '🎉 Mark Delivered', callback_data: 'acct_deliver_start' },
    ],
    [
      { text: '🚫 Close Orders', callback_data: 'acct_close_prompt' },
      { text: '✅ Open Orders', callback_data: 'acct_open' },
    ],
    [{ text: '📊 Status', callback_data: 'acct_status' }],
  ],
};

const acctStart = async (ctx) => {
  await ctx.reply(
    `🏦 <b>Accounting Bot</b>\n\nChoose an action:`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB }
  );
};

// ─── Callback handlers ────────────────────────────────────────────────────────

const acctTrackStart = async (ctx) => {
  await ctx.answerCbQuery();
  acctSessions.set(ctx.from.id, { action: 'track' });
  await ctx.reply(
    `📬 <b>Add Tracking</b>\n\nSend the order ID and tracking URL:\n\n<code>ORDER_ID TRACKING_URL</code>\n\nExample: <code>42 https://track.usps.com/...</code>`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'acct_cancel' }]] } }
  );
};

const acctDeliverStart = async (ctx) => {
  await ctx.answerCbQuery();
  acctSessions.set(ctx.from.id, { action: 'deliver' });
  await ctx.reply(
    `🎉 <b>Mark Delivered</b>\n\nSend the order ID:\n\n<code>ORDER_ID</code>`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'acct_cancel' }]] } }
  );
};

const acctClosePrompt = async (ctx) => {
  await ctx.answerCbQuery();
  acctSessions.set(ctx.from.id, { action: 'close' });
  await ctx.reply(
    `🚫 <b>Close Orders</b>\n\nSend a message to show customers, or tap the button to use the default:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 Close with default message', callback_data: 'acct_close_default' }],
          [{ text: '◀️ Back', callback_data: 'acct_cancel' }],
        ],
      },
    }
  );
};

const acctCloseDefault = async (ctx) => {
  await ctx.answerCbQuery();
  acctSessions.delete(ctx.from.id);
  const msg = 'Stores are temporarily closed. Please try again later.';
  await setSetting('orders_open', 'false');
  await setSetting('orders_closed_message', msg);
  await ctx.editMessageText(
    `🚫 Ordering is now <b>CLOSED</b>.\n\nMessage shown to customers:\n"${msg}"`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB }
  );
};

const acctOpenCb = async (ctx) => {
  await ctx.answerCbQuery();
  await setSetting('orders_open', 'true');
  await ctx.editMessageText(
    `✅ Ordering is now <b>OPEN</b>. Customers can place orders again.`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB }
  );
};

const acctStatusCb = async (ctx) => {
  await ctx.answerCbQuery();
  const open = await getSetting('orders_open', 'true');
  const msg = await getSetting('orders_closed_message', '');
  const text = open === 'true'
    ? `✅ Orders are currently <b>OPEN</b>.`
    : `🚫 Orders are currently <b>CLOSED</b>.\n\nMessage: "${msg}"`;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: MAIN_KB });
};

const acctCancel = async (ctx) => {
  await ctx.answerCbQuery();
  acctSessions.delete(ctx.from.id);
  await ctx.editMessageText(`🏦 <b>Accounting Bot</b>\n\nChoose an action:`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
};

// ─── Text handler for pending sessions ───────────────────────────────────────

const acctHandleText = async (ctx) => {
  const session = acctSessions.get(ctx.from.id);
  if (!session) return;

  const text = ctx.message.text.trim();
  acctSessions.delete(ctx.from.id);

  if (session.action === 'track') {
    const spaceIdx = text.indexOf(' ');
    if (spaceIdx === -1) return ctx.reply('❌ Invalid format. Send: ORDER_ID TRACKING_URL', { reply_markup: MAIN_KB });
    const orderId = parseInt(text.slice(0, spaceIdx), 10);
    const trackingLink = text.slice(spaceIdx + 1).trim();
    if (!orderId || !trackingLink) return ctx.reply('❌ Invalid format. Send: ORDER_ID TRACKING_URL', { reply_markup: MAIN_KB });

    const order = await Order.findByPk(orderId);
    if (!order) return ctx.reply(`❌ Order #${orderId} not found.`, { reply_markup: MAIN_KB });

    await order.update({ tracking_link: trackingLink, updated_at: new Date() });
    await ctx.reply(`✅ Tracking link saved for Order #${orderId}.`, { reply_markup: MAIN_KB });

    try {
      const owner = await User.findByPk(order.user_id);
      if (owner) {
        await notifyCustomer(
          owner.telegram_id,
          `📬 <b>Tracking Update — Order #${orderId}</b>\n\nYour order is on its way!\n\n<a href="${trackingLink}">🔗 Track your package</a>`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      logger.warn('Failed to notify customer of tracking:', err.message);
    }

  } else if (session.action === 'deliver') {
    const orderId = parseInt(text, 10);
    if (!orderId) return ctx.reply('❌ Invalid order ID.', { reply_markup: MAIN_KB });

    const order = await Order.findByPk(orderId);
    if (!order) return ctx.reply(`❌ Order #${orderId} not found.`, { reply_markup: MAIN_KB });

    await order.update({ status: 'delivered', updated_at: new Date() });
    await ctx.reply(`✅ Order #${orderId} marked as delivered.`, { reply_markup: MAIN_KB });

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

  } else if (session.action === 'close') {
    await setSetting('orders_open', 'false');
    await setSetting('orders_closed_message', text);
    await ctx.reply(
      `🚫 Ordering is now <b>CLOSED</b>.\n\nMessage shown to customers:\n"${text}"`,
      { parse_mode: 'HTML', reply_markup: MAIN_KB }
    );
  }
};

// ─── Legacy command handlers (kept for backward compat) ───────────────────────

const acctTrack = async (ctx) => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('Usage: /track ORDER_ID TRACKING_URL');
  const orderId = parseInt(parts[1], 10);
  const trackingLink = parts.slice(2).join(' ').trim();
  if (!orderId || !trackingLink) return ctx.reply('Usage: /track ORDER_ID TRACKING_URL');

  const order = await Order.findByPk(orderId);
  if (!order) return ctx.reply(`❌ Order #${orderId} not found.`);

  await order.update({ tracking_link: trackingLink, updated_at: new Date() });
  await ctx.reply(`✅ Tracking link saved for Order #${orderId}.`, { reply_markup: MAIN_KB });

  try {
    const owner = await User.findByPk(order.user_id);
    if (owner) {
      await notifyCustomer(
        owner.telegram_id,
        `📬 <b>Tracking Update — Order #${orderId}</b>\n\nYour order is on its way!\n\n<a href="${trackingLink}">🔗 Track your package</a>`,
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
  await ctx.reply(`✅ Order #${orderId} marked as delivered.`, { reply_markup: MAIN_KB });

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
    { parse_mode: 'HTML', reply_markup: MAIN_KB }
  );
};

const acctOpen = async (ctx) => {
  await setSetting('orders_open', 'true');
  await ctx.reply(`✅ Ordering is now <b>OPEN</b>. Customers can place orders again.`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
};

const acctStatus = async (ctx) => {
  const open = await getSetting('orders_open', 'true');
  const msg = await getSetting('orders_closed_message', '');
  if (open === 'true') {
    await ctx.reply('✅ Orders are currently <b>OPEN</b>.', { parse_mode: 'HTML', reply_markup: MAIN_KB });
  } else {
    await ctx.reply(
      `🚫 Orders are currently <b>CLOSED</b>.\n\nMessage: "${msg}"`,
      { parse_mode: 'HTML', reply_markup: MAIN_KB }
    );
  }
};

module.exports = {
  acctStart,
  acctTrackStart, acctDeliverStart, acctClosePrompt, acctCloseDefault,
  acctOpenCb, acctStatusCb, acctCancel,
  acctHandleText,
  acctTrack, acctDeliver, acctClose, acctOpen, acctStatus,
};
