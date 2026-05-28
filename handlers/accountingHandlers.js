const Order = require('../models/Order');
const User = require('../models/User');
const { getSetting, setSetting } = require('../models/Setting');
const { notifyCustomer } = require('../services/notificationService');
const logger = require('../utils/logger');

// Pending sessions: telegram_id → { action, orderId? }
const acctSessions = new Map();

const CABLE_NAMES = {
  vm:  '16-Pin Volvo/Mack',
  obd: '16-Pin OBD2 Box Truck',
  rp:  '14-Pin RP1226',
  p9:  '9-Pin Cable',
};

const MAIN_KB = {
  inline_keyboard: [
    [{ text: '📋 Active Orders', callback_data: 'acct_active_orders' }],
    [{ text: '⚙️ Order Management', callback_data: 'acct_management' }],
    [{ text: '📜 Order History', callback_data: 'acct_history' }],
  ],
};

const BACK_MAIN_KB = { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'acct_main_menu' }]] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatOrderDetail(order, user) {
  const platform = user?.platform || 'leader';
  const platformLabel = platform === 'factor' ? 'Factor ELD' : 'Leader ELD';
  const date = new Date(order.created_at).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  let itemsText = '';
  try {
    const items = JSON.parse(order.items || '{}');
    if (items.type === 'fullset') {
      itemsText = `🎯 Full Set ×${items.sets} | Cable: ${CABLE_NAMES[items.cable_type] || items.cable_type}\n`;
    } else if (items.type === 'custom') {
      if (items.pt30) itemsText += `📱 ${items.pt30}× PT30\n`;
      for (const [k, name] of Object.entries(CABLE_NAMES)) {
        if (items[k]) itemsText += `🔌 ${items[k]}× ${name}\n`;
      }
    }
  } catch { itemsText = `📦 ${order.qty || 1}× PT30\n`; }

  return (
    `📦 <b>Order #${order.id}</b>  <i>${date}</i>\n\n` +
    `👤 ${order.owner_name}\n` +
    `🏢 ${order.company_name} <b>(${platformLabel})</b>\n` +
    `📧 ${order.email}\n` +
    `📱 ${order.phone}\n` +
    `📍 ${order.location}\n\n` +
    itemsText +
    `💰 <b>Total: $${parseFloat(order.total || 0).toFixed(2)}</b>\n\n` +
    (order.tracking_link
      ? `📬 Tracking: <a href="${order.tracking_link}">View link</a>`
      : `📬 Tracking: <i>Not added yet</i>`)
  );
}

function orderDetailKb(orderId, hasTracking) {
  const rows = [];
  if (!hasTracking) {
    rows.push([{ text: '📬 Add Tracking Link', callback_data: `acct_add_track_${orderId}` }]);
  }
  rows.push([{ text: '🎉 Mark Delivered', callback_data: `acct_deliver_cb_${orderId}` }]);
  rows.push([{ text: '◀️ Back to Active Orders', callback_data: 'acct_active_orders' }]);
  return { inline_keyboard: rows };
}

// ─── Main menu ────────────────────────────────────────────────────────────────

const acctStart = async (ctx) => {
  await ctx.reply(`🏦 <b>Accounting Bot</b>\n\nChoose a section:`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
};

const acctMainMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    acctSessions.delete(ctx.from.id);
    await ctx.editMessageText(`🏦 <b>Accounting Bot</b>\n\nChoose a section:`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
  } catch { /* message unchanged */ }
};

// ─── Active Orders ────────────────────────────────────────────────────────────

const acctActiveOrders = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    acctSessions.delete(ctx.from.id);
    const orders = await Order.findAll({ where: { status: 'active' }, order: [['created_at', 'DESC']], limit: 30 });

    if (!orders.length) {
      return ctx.editMessageText(
        `📋 <b>Active Orders</b>\n\nNo active orders right now.`,
        { parse_mode: 'HTML', reply_markup: BACK_MAIN_KB }
      );
    }

    const userIds = [...new Set(orders.map(o => o.user_id))];
    const users = await User.findAll({ where: { id: userIds } });
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const buttons = orders.map(o => {
      const u = userMap[o.user_id];
      const platform = u?.platform === 'factor' ? 'F' : 'L';
      const label = `#${o.id} [${platform}] ${o.owner_name} — $${parseFloat(o.total || 0).toFixed(2)}${o.tracking_link ? ' 📬' : ''}`;
      return [{ text: label, callback_data: `acct_order_${o.id}` }];
    });

    buttons.push([{ text: '◀️ Back', callback_data: 'acct_main_menu' }]);

    await ctx.editMessageText(
      `📋 <b>Active Orders</b> (${orders.length})\n\n[L] = Leader  [F] = Factor  📬 = has tracking`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('acctActiveOrders error:', err);
    await ctx.reply('❌ Error loading orders.');
  }
};

const acctOrderDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1], 10);
    const order = await Order.findByPk(orderId);
    if (!order) return ctx.editMessageText('❌ Order not found.', { reply_markup: BACK_MAIN_KB });

    const user = await User.findByPk(order.user_id);
    await ctx.editMessageText(
      formatOrderDetail(order, user),
      { parse_mode: 'HTML', reply_markup: orderDetailKb(orderId, !!order.tracking_link) }
    );
  } catch (err) {
    logger.error('acctOrderDetail error:', err);
    await ctx.reply('❌ Error loading order.');
  }
};

// ─── Add Tracking (from order detail button) ─────────────────────────────────

const acctAddTrackingStart = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1], 10);
    acctSessions.set(ctx.from.id, { action: 'track', orderId });
    await ctx.editMessageText(
      `📬 <b>Add Tracking Link</b>\n\nSend the tracking URL for Order #${orderId}:`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: `acct_order_${orderId}` }]] },
      }
    );
  } catch (err) {
    logger.error('acctAddTrackingStart error:', err);
  }
};

// ─── Mark Delivered (from order detail button) ────────────────────────────────

const acctDeliverCb = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1], 10);
    const order = await Order.findByPk(orderId);
    if (!order) return ctx.editMessageText('❌ Order not found.', { reply_markup: BACK_MAIN_KB });

    await order.update({ status: 'delivered', updated_at: new Date() });

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

    await ctx.editMessageText(
      `✅ Order #${orderId} marked as delivered. Customer notified.`,
      { reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Active Orders', callback_data: 'acct_active_orders' }]] } }
    );
  } catch (err) {
    logger.error('acctDeliverCb error:', err);
    await ctx.reply('❌ Error updating order.');
  }
};

// ─── Order Management (close/open/status) ────────────────────────────────────

const MGMT_KB = {
  inline_keyboard: [
    [
      { text: '🚫 Close Orders', callback_data: 'acct_close_prompt' },
      { text: '✅ Open Orders', callback_data: 'acct_open' },
    ],
    [{ text: '📊 Status', callback_data: 'acct_status' }],
    [{ text: '◀️ Back', callback_data: 'acct_main_menu' }],
  ],
};

async function buildMgmtMessage() {
  const open = await getSetting('orders_open', 'true');
  const closedMsg = await getSetting('orders_closed_message', '');
  const statusLine = open === 'true'
    ? `✅ Orders are currently <b>OPEN</b>`
    : `🚫 Orders are currently <b>CLOSED</b>\n<i>"${closedMsg}"</i>`;

  const toggleBtn = open === 'true'
    ? { text: '🚫 Close Orders', callback_data: 'acct_close_prompt' }
    : { text: '✅ Open Orders', callback_data: 'acct_open' };

  const kb = {
    inline_keyboard: [
      [toggleBtn],
      [{ text: '◀️ Back', callback_data: 'acct_main_menu' }],
    ],
  };
  return { text: `⚙️ <b>Order Management</b>\n\n${statusLine}`, kb };
}

const acctManagement = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const { text, kb } = await buildMgmtMessage();
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (err) {
    logger.error('acctManagement error:', err);
  }
};

const acctClosePrompt = async (ctx) => {
  await ctx.answerCbQuery();
  acctSessions.set(ctx.from.id, { action: 'close' });
  await ctx.editMessageText(
    `🚫 <b>Close Orders</b>\n\nSend a custom message to show customers, or use the default:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚫 Close with default message', callback_data: 'acct_close_default' }],
          [{ text: '◀️ Back', callback_data: 'acct_management' }],
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
  const { text, kb } = await buildMgmtMessage();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
};

const acctOpenCb = async (ctx) => {
  await ctx.answerCbQuery();
  await setSetting('orders_open', 'true');
  const { text, kb } = await buildMgmtMessage();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
};

const acctStatusCb = async (ctx) => {
  await ctx.answerCbQuery();
  const { text, kb } = await buildMgmtMessage();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
};

// ─── Order History ────────────────────────────────────────────────────────────

const acctHistory = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orders = await Order.findAll({ where: { status: 'delivered' }, order: [['updated_at', 'DESC']], limit: 30 });

    if (!orders.length) {
      return ctx.editMessageText(
        `📜 <b>Order History</b>\n\nNo delivered orders yet.`,
        { parse_mode: 'HTML', reply_markup: BACK_MAIN_KB }
      );
    }

    const userIds = [...new Set(orders.map(o => o.user_id))];
    const users = await User.findAll({ where: { id: userIds } });
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const buttons = orders.map(o => {
      const u = userMap[o.user_id];
      const platform = u?.platform === 'factor' ? 'F' : 'L';
      const label = `#${o.id} [${platform}] ${o.owner_name} — $${parseFloat(o.total || 0).toFixed(2)} ✅`;
      return [{ text: label, callback_data: `acct_history_order_${o.id}` }];
    });

    buttons.push([{ text: '◀️ Back', callback_data: 'acct_main_menu' }]);

    await ctx.editMessageText(
      `📜 <b>Order History</b> (${orders.length} delivered)`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('acctHistory error:', err);
    await ctx.reply('❌ Error loading history.');
  }
};

const acctHistoryOrder = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1], 10);
    const order = await Order.findByPk(orderId);
    if (!order) return ctx.editMessageText('❌ Order not found.', { reply_markup: BACK_MAIN_KB });

    const user = await User.findByPk(order.user_id);
    await ctx.editMessageText(
      formatOrderDetail(order, user) + '\n\n✅ <b>Delivered</b>',
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back to History', callback_data: 'acct_history' }]] },
      }
    );
  } catch (err) {
    logger.error('acctHistoryOrder error:', err);
    await ctx.reply('❌ Error loading order.');
  }
};

// ─── Text handler for pending sessions ───────────────────────────────────────

const acctHandleText = async (ctx) => {
  const session = acctSessions.get(ctx.from.id);
  if (!session) return;

  const text = ctx.message.text.trim();
  acctSessions.delete(ctx.from.id);

  if (session.action === 'track') {
    const { orderId } = session;
    const trackingLink = text;
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

  } else if (session.action === 'close') {
    await setSetting('orders_open', 'false');
    await setSetting('orders_closed_message', text);
    const { text: mgmtText, kb } = await buildMgmtMessage();
    await ctx.reply(mgmtText, { parse_mode: 'HTML', reply_markup: kb });
  }
};

// ─── Legacy command handlers ──────────────────────────────────────────────────

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
  await ctx.reply(`🚫 Ordering is now <b>CLOSED</b>.\n\nMessage: "${msg}"`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
};

const acctOpen = async (ctx) => {
  await setSetting('orders_open', 'true');
  await ctx.reply(`✅ Ordering is now <b>OPEN</b>.`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
};

const acctStatus = async (ctx) => {
  const open = await getSetting('orders_open', 'true');
  const msg = await getSetting('orders_closed_message', '');
  const text = open === 'true'
    ? `✅ Orders are currently <b>OPEN</b>.`
    : `🚫 Orders are currently <b>CLOSED</b>.\n\nMessage: "${msg}"`;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: MAIN_KB });
};

module.exports = {
  acctStart, acctMainMenu,
  acctActiveOrders, acctOrderDetail,
  acctAddTrackingStart, acctDeliverCb,
  acctManagement, acctClosePrompt, acctCloseDefault, acctOpenCb, acctStatusCb,
  acctHistory, acctHistoryOrder,
  acctHandleText,
  acctTrack, acctDeliver, acctClose, acctOpen, acctStatus,
};
