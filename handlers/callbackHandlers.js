const User = require('../models/User');
const Driver = require('../models/Driver');
const logger = require('../utils/logger');
const { syncDrivers } = require('./commandHandlers');
const { fetchDriverStatus, fetchVehicleStatus, formatSeconds, reverseGeocode } = require('../services/eldService');

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
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
    await ctx.editMessageText(info, { parse_mode: 'HTML', reply_markup: keyboard });
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
      return ctx.editMessageText(
        'No drivers found.\n\nConnect your ELD:\n/setapi YOUR_COMPANY_KEY'
      );
    }

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
    const driverId = ctx.match[1];
    await renderDriverDetails(ctx, driverId, true);
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

    // Fetch live HOS + vehicle data in parallel
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
          reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `driver_details_${driverId}` }]],
          },
        }
      );
    }

    const mapsUrl = `https://www.google.com/maps?q=${driver.latitude},${driver.longitude}`;

    const text =
      `📍 <b>Last Known Location</b>\n\n` +
      (driver.location_string ? `📌 ${driver.location_string}\n\n` : '') +
      `Latitude: ${driver.latitude}\n` +
      `Longitude: ${driver.longitude}`;

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗺️ Open in Maps', url: mapsUrl }],
          [{ text: '◀️ Back', callback_data: `driver_details_${driverId}` }],
        ],
      },
    });
  } catch (error) {
    logger.error('driverLocation error:', error);
    await ctx.reply('❌ Error loading location.');
  }
};

// ─── Order Flow ──────────────────────────────────────────────────────────────

const DEVICE_PRICE = 179;
const OVERNIGHT_EXTRA = 100;

const orderStart = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📦 <b>Device Order</b>\n\nPlease select quantity:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `1x PT30 ($${DEVICE_PRICE})`, callback_data: 'order_qty_1' }],
            [{ text: `2x PT30 ($${DEVICE_PRICE * 2})`, callback_data: 'order_qty_2' }],
            [{ text: `3x PT30 ($${DEVICE_PRICE * 3})`, callback_data: 'order_qty_3' }],
            [{ text: 'Custom quantity', callback_data: 'order_qty_custom' }],
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

const orderQuantity = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const raw = ctx.match[1];

    if (raw === 'custom') {
      // Store pending state so messageHandler can capture the next message
      orderPendingCustomQty.set(ctx.from.id, true);
      await ctx.editMessageText(
        `📦 <b>Custom Quantity</b>\n\nHow many PT30 devices do you need?\n\nReply with a number (e.g. <code>5</code>)`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: 'order_devices_start' }]],
          },
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
      [{ text: '◀️ Back', callback_data: 'order_devices_start' }],
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
    const subtotal = qty * DEVICE_PRICE;
    const shippingCost = shipping === 'overnight' ? OVERNIGHT_EXTRA : 0;
    const total = subtotal + shippingCost;
    const shippingLabel = shipping === 'overnight' ? 'Overnight (+$100)' : 'Standard (FREE)';

    // Store pending order state
    orderPendingInfo.set(ctx.from.id, { qty, shipping, total });

    await ctx.editMessageText(
      `📦 <b>Order Summary</b>\n\n` +
      `${qty}x PT30 ELD @ $${DEVICE_PRICE} each\n` +
      `Shipping: ${shippingLabel}\n` +
      `<b>Total: $${total}</b>\n\n` +
      `To complete your order, please reply with:\n` +
      `• Company name\n` +
      `• Shipping address\n` +
      `• Contact phone`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'order_devices_start' }]],
        },
      }
    );
  } catch (error) {
    logger.error('orderShipping error:', error);
    await ctx.reply('❌ Error.');
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
      `I'll help you monitor your drivers and manage device orders!\n\n` +
      companyLine,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 View Drivers', callback_data: 'drivers_list' }],
            [{ text: '📦 Order Devices', callback_data: 'order_devices_start' }],
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
        reply_markup: {
          inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main_menu' }]],
        },
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
      `<b>How to get your Company API Key:</b>\n` +
      `ELD portal → Settings → API Key → Generate`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main_menu' }]],
        },
      }
    );
  } catch (error) {
    logger.error('helpMenu error:', error);
  }
};

// ─── Shared state for multi-step order flow ──────────────────────────────────
const orderPendingCustomQty = new Map(); // telegram_id -> true
const orderPendingInfo = new Map();      // telegram_id -> { qty, shipping, total }

module.exports = {
  driverDetails,
  driverRefresh,
  driversList,
  driversListRefresh,
  driverLocation,
  orderStart,
  orderQuantity,
  orderShipping,
  mainMenu,
  changeTeam,
  helpMenu,
  orderPendingCustomQty,
  orderPendingInfo,
  showShippingSelection,
};
