const { Op } = require('sequelize');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Order = require('../models/Order');
const Inspection = require('../models/Inspection');
const logger = require('../utils/logger');
const { syncDrivers } = require('./commandHandlers');
const { fetchDriverStatus, fetchVehicleStatus, formatSeconds } = require('../services/eldService');

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

async function renderDriverDetails(ctx, driverId, editMessage = true) {
  const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
  if (!user) return ctx.reply('Please /start first.');

  const driver = await Driver.findOne({ where: { driver_id: driverId, user_id: user.id } });
  if (!driver) return editMessage ? ctx.editMessageText('Driver not found.') : ctx.reply('Driver not found.');

  const info =
    `👤 <b>${driver.driver_name}</b>\n` +
    (driver.truck_number ? `<i>Truck #${driver.truck_number}</i>\n\n` : '\n') +
    `📋 Status: ${driver.current_status || 'Unknown'}\n` +
    (driver.speed != null ? `🚗 Speed: ${driver.speed} mph\n` : '') +
    `\n⏰ <b>HOS Clocks</b>\n` +
    `Drive time: <b>${formatSeconds(driver.drive_remaining)}</b>\n` +
    `Shift time: <b>${formatSeconds(driver.shift_remaining)}</b>\n` +
    `Break time: <b>${formatSeconds(driver.break_remaining)}</b>\n` +
    `Cycle time: <b>${formatSeconds(driver.cycle_remaining)}</b>\n` +
    `\nLast Updated: ${formatTime(driver.updated_at)}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: `driver_refresh_${driverId}` }],
      ...(driver.latitude && driver.longitude
        ? [[{ text: '📍 Location', callback_data: `driver_location_${driverId}` }]]
        : []),
      [{ text: '◀️ Back', callback_data: 'drivers_list' }],
    ],
  };

  if (editMessage) {
    try {
      await ctx.editMessageText(info, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err) {
      if (!err.message?.includes('message is not modified')) throw err;
    }
  } else {
    await ctx.reply(info, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// ─── Driver Handlers ─────────────────────────────────────────────────────────

const driversList = async (ctx) => {
  try {
    try { await ctx.answerCbQuery(); } catch (_) {}

    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const driverList = await Driver.findAll({ where: { user_id: user.id } });
    if (!driverList.length) {
      return ctx.editMessageText('No drivers found.\n\nConnect your ELD:\n/setapi YOUR_COMPANY_KEY');
    }

    try {
      await ctx.editMessageText(
        `👥 <b>Your Drivers (${driverList.length})</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              ...driverList.map((d) => [
                { text: `👤 ${d.driver_name}`, callback_data: `driver_details_${d.driver_id}` },
              ]),
              [{ text: '🔄 Refresh List', callback_data: 'drivers_list_refresh' }],
              [{ text: '◀️ Back', callback_data: 'main_menu' }],
            ],
          },
        }
      );
    } catch (err) {
      if (!err.message?.includes('message is not modified')) throw err;
    }
  } catch (error) {
    logger.error('driversList error:', error);
    await ctx.reply('❌ Error loading drivers.');
  }
};

const driversListRefresh = async (ctx) => {
  try {
    await ctx.answerCbQuery('Syncing...');
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    if (user.company_api_key) {
      await syncDrivers(user, user.company_api_key).catch(e => logger.warn('Refresh sync failed:', e.message));
    }

    await driversList(ctx);
  } catch (error) {
    logger.error('driversListRefresh error:', error);
    await ctx.reply('❌ Error refreshing.');
  }
};

const driverDetails = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await renderDriverDetails(ctx, ctx.match[1], true);
  } catch (error) {
    logger.error('driverDetails error:', error);
    await ctx.reply('❌ Error loading driver details.');
  }
};

const driverRefresh = async (ctx) => {
  try {
    await ctx.answerCbQuery('Refreshing...');
    const driverId = ctx.match[1];
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user || !user.company_api_key) return ctx.reply('Please /start first.');

    const [statusRaw, vehicleRaw] = await Promise.all([
      fetchDriverStatus(user.company_api_key),
      fetchVehicleStatus(user.company_api_key),
    ]);

    const st = statusRaw.find(s => String(s.driver_id) === String(driverId)) || {};
    const v  = vehicleRaw.find(v => String(v.driver_id) === String(driverId)) || {};

    const driver = await Driver.findOne({ where: { driver_id: driverId, user_id: user.id } });
    if (driver) {
      const STATUS_LABELS = {
        'DS_D': 'DRIVING', 'DS_ON': 'ON DUTY', 'DS_OFF': 'OFF DUTY',
        'DS_SB': 'SLEEPER BERTH', 'DS_PC': 'PERSONAL CONVEYANCE', 'DS_YM': 'YARD MOVE',
      };
      await driver.update({
        current_status:  STATUS_LABELS[st.current_status] || st.current_status || driver.current_status,
        speed:           v.speed           ?? driver.speed,
        latitude:        v.lat             ? parseFloat(v.lat) : driver.latitude,
        longitude:       v.lon             ? parseFloat(v.lon) : driver.longitude,
        truck_number:    v.number           || driver.truck_number,
        location_string: v.calc_location   || driver.location_string,
        drive_remaining: st.drive          ?? driver.drive_remaining,
        shift_remaining: st.shift          ?? driver.shift_remaining,
        break_remaining: st.break          ?? driver.break_remaining,
        cycle_remaining: st.cycle          ?? driver.cycle_remaining,
        updated_at:      new Date(),
      });
    }

    await renderDriverDetails(ctx, driverId, true);
  } catch (error) {
    logger.error('driverRefresh error:', error);
    await ctx.reply('❌ Error refreshing driver.');
  }
};

const driverLocation = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const driverId = ctx.match[1];
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const driver = await Driver.findOne({ where: { driver_id: driverId, user_id: user.id } });
    if (!driver) return ctx.editMessageText('Driver not found.');

    if (!driver.latitude || !driver.longitude) {
      return ctx.editMessageText(
        `📍 No location data available for <b>${driver.driver_name}</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: `driver_details_${driverId}` }]] },
        }
      );
    }

    const mapsUrl = `https://www.google.com/maps?q=${driver.latitude},${driver.longitude}`;
    await ctx.editMessageText(
      `📍 <b>Last Known Location</b>\n\n` +
      (driver.location_string ? `📌 ${driver.location_string}\n\n` : '') +
      `Latitude: ${driver.latitude}\n` +
      `Longitude: ${driver.longitude}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗺️ Open in Maps', url: mapsUrl }],
            [{ text: '◀️ Back', callback_data: `driver_details_${driverId}` }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('driverLocation error:', error);
    await ctx.reply('❌ Error loading location.');
  }
};

// ─── Order Flow ──────────────────────────────────────────────────────────────

const DEVICE_PRICE = 179;
const OVERNIGHT_EXTRA = 100;
const HISTORY_PAGE_SIZE = 5;

const CANCEL_KB = { inline_keyboard: [[{ text: '❌ Cancel Order', callback_data: 'order_cancel' }]] };

const ORDER_STEPS = ['owner_name', 'company_name', 'email', 'phone', 'location', 'cable_pin', 'stickers'];

const ORDER_PROMPTS = {
  owner_name:   '👤 <b>(1/7) Owner Name</b>\n\nPlease enter the owner\'s full name:',
  company_name: '🏢 <b>(2/7) Company Name</b>\n\nPlease enter your company name:',
  email:        '📧 <b>(3/7) Email Address</b>\n\nPlease enter your email address:',
  phone:        '📱 <b>(4/7) Phone Number</b>\n\nPlease enter your contact phone number:',
  location:     '📍 <b>(5/7) Delivery Location</b>\n\nPlease enter your full delivery address:',
  cable_pin:    '🔌 <b>(6/7) Cable PIN</b>\n\nPlease enter the Cable PIN:',
  stickers:     '🏷️ <b>(7/7) Stickers Count</b>\n\nHow many stickers do you need?',
};

// order_devices_start → submenu
const orderStart = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    const activeCount = user ? await Order.count({ where: { user_id: user.id, status: 'active' } }) : 0;

    await ctx.editMessageText(
      `📦 <b>Device Orders</b>\n\nWhat would you like to do?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 New Order', callback_data: 'order_new' }],
            [{ text: `📋 Active Orders${activeCount ? ` (${activeCount})` : ''}`, callback_data: 'order_active' }],
            [{ text: '📜 Order History', callback_data: 'order_history_0' }],
            [{ text: '◀️ Back', callback_data: 'main_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('orderStart error:', error);
    await ctx.reply('❌ Error.');
  }
};

// order_new → qty selection
const orderNew = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📦 <b>New Order</b>\n\nPlease select quantity:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `1x PT30 ($${DEVICE_PRICE})`, callback_data: 'order_qty_1' }],
            [{ text: `2x PT30 ($${DEVICE_PRICE * 2})`, callback_data: 'order_qty_2' }],
            [{ text: `3x PT30 ($${DEVICE_PRICE * 3})`, callback_data: 'order_qty_3' }],
            [{ text: 'Custom quantity', callback_data: 'order_qty_custom' }],
            [{ text: '◀️ Back', callback_data: 'order_devices_start' }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('orderNew error:', error);
    await ctx.reply('❌ Error.');
  }
};

const orderQuantity = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const raw = ctx.match[1];

    if (raw === 'custom') {
      orderPendingCustomQty.set(ctx.from.id, true);
      await ctx.editMessageText(
        `📦 <b>Custom Quantity</b>\n\nHow many PT30 devices do you need?\n\nReply with a number (e.g. <code>5</code>)`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'order_new' }]] },
        }
      );
      return;
    }

    const qty = parseInt(raw, 10);
    if (!qty || qty < 1) return ctx.answerCbQuery('Invalid quantity');
    await showShippingSelection(ctx, qty, true);
  } catch (error) {
    logger.error('orderQuantity error:', error);
    await ctx.reply('❌ Error.');
  }
};

async function showShippingSelection(ctx, qty, edit = true) {
  const subtotal = qty * DEVICE_PRICE;
  const text =
    `📦 <b>Select Shipping</b>\n\n` +
    `${qty}x PT30 = $${subtotal}\n\n` +
    `Choose shipping method:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🚚 Standard (FREE)', callback_data: `order_ship_standard_${qty}` }],
      [{ text: '🚀 Overnight (+$100)', callback_data: `order_ship_overnight_${qty}` }],
      [{ text: '◀️ Back', callback_data: 'order_new' }],
    ],
  };

  if (edit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

const orderShipping = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const [, shipping, qtyStr] = ctx.match;
    const qty = parseInt(qtyStr, 10);
    const total = qty * DEVICE_PRICE + (shipping === 'overnight' ? OVERNIGHT_EXTRA : 0);

    orderSessions.set(ctx.from.id, { step: 'owner_name', qty, shipping, total });

    await ctx.editMessageText(ORDER_PROMPTS.owner_name, { parse_mode: 'HTML', reply_markup: CANCEL_KB });
  } catch (error) {
    logger.error('orderShipping error:', error);
    await ctx.reply('❌ Error.');
  }
};

const orderConfirm = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const session = orderSessions.get(ctx.from.id);
    if (!session) return ctx.reply('Session expired. Please /start again.');

    session.step = 'payment';
    const zelleAddress = process.env.ZELLE_ADDRESS || 'LEADER ELD LLC';

    await ctx.editMessageText(
      `💳 <b>Payment Required</b>\n\n` +
      `Amount due: <b>$${session.total}</b>\n\n` +
      `Please send payment via <b>Zelle</b>:\n` +
      `📲 <code>${zelleAddress}</code>\n\n` +
      `After payment, send a <b>photo or PDF</b> of your payment screenshot here.`,
      { parse_mode: 'HTML', reply_markup: CANCEL_KB }
    );
  } catch (error) {
    logger.error('orderConfirm error:', error);
    await ctx.reply('❌ Error.');
  }
};

const orderEdit = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const session = orderSessions.get(ctx.from.id);
    if (!session) return ctx.reply('Session expired. Please /start again.');

    session.step = 'owner_name';
    ORDER_STEPS.forEach(k => delete session[k]);

    await ctx.editMessageText(
      `✏️ Let's re-enter your details.\n\n` + ORDER_PROMPTS.owner_name,
      { parse_mode: 'HTML', reply_markup: CANCEL_KB }
    );
  } catch (error) {
    logger.error('orderEdit error:', error);
    await ctx.reply('❌ Error.');
  }
};

const orderCancel = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    orderSessions.delete(ctx.from.id);
    await ctx.editMessageText(
      `❌ <b>Order Cancelled</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Orders', callback_data: 'order_devices_start' }]] },
      }
    );
  } catch (error) {
    logger.error('orderCancel error:', error);
    await ctx.reply('Order cancelled.');
  }
};

// Active orders list
const orderActive = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const orders = await Order.findAll({
      where: { user_id: user.id, status: 'active' },
      order: [['created_at', 'DESC']],
    });

    if (!orders.length) {
      return ctx.editMessageText(
        `📋 <b>Active Orders</b>\n\nNo active orders.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'order_devices_start' }]] },
        }
      );
    }

    await ctx.editMessageText(
      `📋 <b>Active Orders (${orders.length})</b>\n\nTap an order to view details and tracking.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            ...orders.map(o => [{
              text: `📦 Order #${o.id} — ${o.qty}× PT30 — $${o.total} — ${formatDate(o.created_at)}`,
              callback_data: `order_detail_${o.id}`,
            }]),
            [{ text: '◀️ Back', callback_data: 'order_devices_start' }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('orderActive error:', error);
    await ctx.reply('❌ Error loading active orders.');
  }
};

// Order history (paginated)
const orderHistory = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1], 10) || 0;
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const total = await Order.count({ where: { user_id: user.id } });

    if (!total) {
      return ctx.editMessageText(
        `📜 <b>Order History</b>\n\nNo orders yet.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'order_devices_start' }]] },
        }
      );
    }

    const orders = await Order.findAll({
      where: { user_id: user.id },
      order: [['created_at', 'DESC']],
      limit: HISTORY_PAGE_SIZE,
      offset: page * HISTORY_PAGE_SIZE,
    });

    const totalPages = Math.ceil(total / HISTORY_PAGE_SIZE);
    const navRow = [];
    if (page > 0) navRow.push({ text: '◀️ Prev', callback_data: `order_history_${page - 1}` });
    if (page < totalPages - 1) navRow.push({ text: 'Next ▶️', callback_data: `order_history_${page + 1}` });

    await ctx.editMessageText(
      `📜 <b>Order History (${total})</b>\n\nPage ${page + 1} of ${totalPages}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            ...orders.map(o => {
              const statusIcon = o.status === 'delivered' ? '✅' : '🔄';
              return [{ text: `${statusIcon} #${o.id} — ${o.qty}× PT30 — $${o.total} — ${formatDate(o.created_at)}`, callback_data: `order_detail_${o.id}` }];
            }),
            ...(navRow.length ? [navRow] : []),
            [{ text: '◀️ Back', callback_data: 'order_devices_start' }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('orderHistory error:', error);
    await ctx.reply('❌ Error loading order history.');
  }
};

// Order detail view
const orderDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1], 10);
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const order = await Order.findOne({ where: { id: orderId, user_id: user.id } });
    if (!order) return ctx.editMessageText('Order not found.');

    const shippingLabel = order.shipping === 'overnight' ? 'Overnight (+$100)' : 'Standard (FREE)';
    const statusLine = order.status === 'delivered'
      ? '✅ <b>Delivered</b>'
      : '🔄 <b>Active</b> (awaiting delivery)';

    const text =
      `📦 <b>Order #${order.id}</b>\n\n` +
      `Status: ${statusLine}\n` +
      `📅 Placed: ${formatDate(order.created_at)}\n\n` +
      `👤 Owner: ${order.owner_name}\n` +
      `🏢 Company: ${order.company_name}\n` +
      `📧 Email: ${order.email}\n` +
      `📱 Phone: ${order.phone}\n` +
      `📍 Delivery: ${order.location}\n` +
      `🔌 Cable PIN: ${order.cable_pin}\n` +
      `🏷️ Stickers: ${order.stickers}\n\n` +
      `📦 ${order.qty}× PT30 ELD @ $179 each\n` +
      `🚚 Shipping: ${shippingLabel}\n` +
      `💰 Total: $${order.total}\n\n` +
      (order.tracking_link
        ? `📬 <b>Tracking available</b>`
        : `📬 Tracking: Not available yet`);

    const keyboard = {
      inline_keyboard: [
        ...(order.tracking_link ? [[{ text: '🔗 Track Package', url: order.tracking_link }]] : []),
        [{ text: '◀️ Back', callback_data: order.status === 'active' ? 'order_active' : 'order_history_0' }],
      ],
    };

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (error) {
    logger.error('orderDetail error:', error);
    await ctx.reply('❌ Error loading order.');
  }
};

// ─── DOT Inspection Handlers ──────────────────────────────────────────────────

const dotMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const total = await Inspection.count({ where: { user_id: user.id } });

    if (!total) {
      return ctx.editMessageText(
        `🚔 <b>DOT Inspections</b>\n\nNo inspections recorded yet.\n\nYou'll receive an alert here when a driver's log is submitted to the DOT.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main_menu' }]] },
        }
      );
    }

    const inspections = await Inspection.findAll({
      where: { user_id: user.id },
      order: [['inspection_date', 'DESC'], ['created_at', 'DESC']],
      limit: 10,
    });

    await ctx.editMessageText(
      `🚔 <b>DOT Inspections (${total})</b>\n\nShowing latest 10. Tap for details.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            ...inspections.map(i => {
              const icon = i.violations > 0 ? '⚠️' : '✅';
              const d = formatDate(i.inspection_date);
              return [{ text: `${icon} ${d} — ${i.driver_name} — Level ${i.level}`, callback_data: `dot_detail_${i.id}` }];
            }),
            [{ text: '◀️ Back', callback_data: 'main_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('dotMenu error:', error);
    await ctx.reply('❌ Error loading inspections.');
  }
};

const dotDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const inspId = parseInt(ctx.match[1], 10);
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const insp = await Inspection.findOne({ where: { id: inspId, user_id: user.id } });
    if (!insp) return ctx.editMessageText('Inspection not found.');

    const vIcon = insp.violations > 0 ? '⚠️' : '✅';

    const text =
      `🚔 <b>DOT Inspection #${insp.id}</b>\n\n` +
      `👤 Driver: ${insp.driver_name}\n` +
      `📅 Date: ${formatDate(insp.inspection_date)}\n` +
      (insp.report_number ? `📋 Report #: ${insp.report_number}\n` : '') +
      (insp.level ? `📊 Level: ${insp.level}\n` : '') +
      `⚠️ Violations: ${insp.violations} ${vIcon}\n` +
      (insp.result ? `📝 Result: <b>${insp.result.toUpperCase()}</b>\n` : '');

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'dot_menu' }]] },
    });
  } catch (error) {
    logger.error('dotDetail error:', error);
    await ctx.reply('❌ Error loading inspection details.');
  }
};

// ─── Main Menu / Help ─────────────────────────────────────────────────────────

const mainMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    const hasKey = user && !!user.company_api_key;
    const companyLine = hasKey
      ? `✅ Connected to <b>${user.company_name || 'ELD'}</b>`
      : '⚠️ No company connected. Use /setapi YOUR_COMPANY_KEY';

    await ctx.editMessageText(
      `👋 Welcome to <b>OWNER ASSISTANT BOT</b>\n\n` +
      `ELD Driver Monitoring &amp; Device Orders\n\n` +
      companyLine,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 View Drivers', callback_data: 'drivers_list' }],
            [{ text: '📦 Order Devices', callback_data: 'order_devices_start' }],
            [{ text: '🚔 DOT Inspections', callback_data: 'dot_menu' }],
            [{ text: '🔄 Change Team', callback_data: 'change_team' }],
            [{ text: '❓ Help', callback_data: 'help_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    logger.error('mainMenu error:', error);
  }
};

const changeTeam = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🔄 <b>Change Team / Company</b>\n\n` +
      `To connect a different company, send:\n\n` +
      `<code>/setapi YOUR_COMPANY_KEY</code>\n\n` +
      `Get your Company API Key from:\nELD portal → Settings → API Key`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main_menu' }]] },
      }
    );
  } catch (error) {
    logger.error('changeTeam error:', error);
  }
};

const helpMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `❓ <b>Help</b>\n\n` +
      `/start - Open main menu\n` +
      `/drivers - List all drivers\n` +
      `/setapi KEY - Connect your ELD company\n` +
      `/orders - Order devices\n\n` +
      `<b>Admin commands (order group only):</b>\n` +
      `/track ORDER_ID URL - Add tracking link\n` +
      `/deliver ORDER_ID - Mark order as delivered\n\n` +
      `<b>How to get your Company API Key:</b>\n` +
      `ELD portal → Settings → API Key → Generate`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main_menu' }]] },
      }
    );
  } catch (error) {
    logger.error('helpMenu error:', error);
  }
};

// ─── Shared state ─────────────────────────────────────────────────────────────
const orderPendingCustomQty = new Map();
const orderSessions = new Map();

module.exports = {
  driverDetails, driverRefresh, driversList, driversListRefresh, driverLocation,
  orderStart, orderNew, orderQuantity, orderShipping, orderConfirm, orderEdit, orderCancel,
  orderActive, orderHistory, orderDetail,
  dotMenu, dotDetail,
  mainMenu, changeTeam, helpMenu,
  orderPendingCustomQty, orderSessions, ORDER_STEPS, ORDER_PROMPTS, CANCEL_KB,
  showShippingSelection,
};
