const { Op } = require('sequelize');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Order = require('../models/Order');
const Inspection = require('../models/Inspection');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const { getSetting } = require('../models/Setting');
const logger = require('../utils/logger');
const { syncDrivers } = require('./commandHandlers');
const { fetchDriverStatus, fetchVehicleStatus, formatSeconds } = require('../services/eldService');

// ─── Driver Status Groups ────────────────────────────────────────────────────

const STATUS_GROUPS = {
  D:   { label: 'Driving',  emoji: '🟢' },
  ON:  { label: 'On Duty',  emoji: '🔵' },
  SB:  { label: 'Sleeper',  emoji: '🟠' },
  OFF: { label: 'Off Duty', emoji: '⚫' },
};

function statusGroupKey(status) {
  if (!status || status === 'OFF DUTY') return 'OFF';
  if (status === 'ON DUTY') return 'ON';
  if (status === 'SLEEPER BERTH') return 'SB';
  return 'D'; // DRIVING, PERSONAL CONVEYANCE, YARD MOVE
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Driver Handlers ──────────────────────────────────────────────────────────

const driversList = async (ctx) => {
  try {
    try { await ctx.answerCbQuery(); } catch (_) {}

    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const drivers = await Driver.findAll({ where: { user_id: user.id } });
    if (!drivers.length) {
      return ctx.editMessageText('No drivers found.\n\nConnect your ELD:\n/setapi YOUR_COMPANY_KEY');
    }

    const counts = { D: 0, ON: 0, SB: 0, OFF: 0 };
    for (const d of drivers) counts[statusGroupKey(d.current_status)]++;

    const makeBtn = (key) => {
      const g = STATUS_GROUPS[key];
      return [{ text: `${g.emoji}  ${g.label}  (${counts[key]})`, callback_data: `drivers_cat_${key}` }];
    };

    try {
      await ctx.editMessageText(
        `👥 <b>Your Drivers (${drivers.length})</b>\n\nSelect a status category:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              makeBtn('D'),
              makeBtn('ON'),
              makeBtn('SB'),
              makeBtn('OFF'),
              [{ text: '🔄 Refresh', callback_data: 'drivers_list_refresh' }],
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

async function renderCategoryList(ctx, key) {
  const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
  if (!user) return ctx.reply('Please /start first.');

  const allDrivers = await Driver.findAll({ where: { user_id: user.id } });
  const g = STATUS_GROUPS[key];
  const drivers = allDrivers.filter(d => statusGroupKey(d.current_status) === key);

  const driverBtns = drivers.map(d => [{
    text: `🚛 ${d.driver_name}`,
    callback_data: `driver_details_${d.driver_id}`,
  }]);

  try {
    await ctx.editMessageText(
      `${g.emoji} <b>${g.label}</b>  (${drivers.length} driver${drivers.length !== 1 ? 's' : ''})` +
      (drivers.length === 0 ? '\n\nNo drivers in this status right now.' : ''),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            ...driverBtns,
            [{ text: '🔄 Refresh', callback_data: `drivers_catref_${key}` }],
            [{ text: '◀️ Back', callback_data: 'drivers_list' }],
          ],
        },
      }
    );
  } catch (err) {
    if (!err.message?.includes('message is not modified')) throw err;
  }
}

const driversCatShow = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await renderCategoryList(ctx, ctx.match[1]);
  } catch (error) {
    logger.error('driversCatShow error:', error);
    await ctx.reply('❌ Error loading category.');
  }
};

const driversCatRefresh = async (ctx) => {
  try {
    await ctx.answerCbQuery('Refreshing...');
    const key = ctx.match[1];
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    if (user.company_api_key) {
      await syncDrivers(user, user.company_api_key).catch(e => logger.warn('Category refresh sync failed:', e.message));
    }

    await renderCategoryList(ctx, key);
  } catch (error) {
    logger.error('driversCatRefresh error:', error);
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
      `Latitude: ${driver.latitude}\nLongitude: ${driver.longitude}`,
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

// ─── Order Constants ──────────────────────────────────────────────────────────

const PRICES = {
  fullset_base:     179.99,
  fullset_overnight: 79.99,
  pt30:             120.00,
  cable:             29.00,
  sticker:            9.99,
  ship_standard:     30.99,
  ship_overnight:    79.99,
};

const CABLE_NAMES = {
  vm:  '16-Pin Heavy Duty',
  obd: '16-Pin Light Duty',
  rp:  '14-Pin',
  p9:  '9-Pin',
};

const HISTORY_PAGE_SIZE = 5;

const CANCEL_KB = { inline_keyboard: [[{ text: '❌ Cancel Order', callback_data: 'order_cancel' }]] };

const ORDER_QA_STEPS = ['owner_name', 'email', 'phone', 'location'];
const ORDER_QA_PROMPTS = {
  owner_name: '👤 <b>(1/4) Owner Name</b>\n\nPlease enter the owner\'s full name:',
  email:      '📧 <b>(2/4) Email Address</b>\n\nPlease enter your email address:',
  phone:      '📱 <b>(3/4) Phone Number</b>\n\nPlease enter your phone number:',
  location:   '📍 <b>(4/4) Delivery Address</b>\n\nPlease enter your full delivery address:',
};

// ─── One-time registration ────────────────────────────────────────────────────

const REG_STEPS = ['reg_owner_name', 'reg_email', 'reg_phone', 'reg_address'];
const REG_PROMPTS = {
  reg_owner_name: '👤 <b>(1/4) Your Full Name</b>\n\nEnter your full name:',
  reg_email:      '📧 <b>(2/4) Email Address</b>\n\nEnter your email address:',
  reg_phone:      '📱 <b>(3/4) Phone Number</b>\n\nEnter your phone number:',
  reg_address:    '📍 <b>(4/4) Delivery Address</b>\n\nEnter your default delivery address (used for all orders):',
};
const registrationSessions = new Map();
const cardSessions = new Map(); // userId → true, waiting for owner to send card number

function computeFullSetTotal(sets, shipping) {
  return parseFloat((sets * PRICES.fullset_base + (shipping === 'overnight' ? PRICES.fullset_overnight : 0)).toFixed(2));
}

function computeCustomTotal(items, shipping) {
  const cables = (items.vm || 0) + (items.obd || 0) + (items.rp || 0) + (items.p9 || 0);
  const itemCost = (items.pt30 || 0) * PRICES.pt30 + cables * PRICES.cable + (items.stk || 0) * PRICES.sticker;
  const shipCost = shipping === 'overnight' ? PRICES.ship_overnight : PRICES.ship_standard;
  return parseFloat((itemCost + shipCost).toFixed(2));
}

function orderListLabel(o) {
  try {
    const items = JSON.parse(o.items || '{}');
    if (items.type === 'fullset') return `Full Set ×${items.sets}`;
    if (items.type === 'custom') {
      const parts = [];
      if (items.pt30 > 0) parts.push(`${items.pt30}× PT30`);
      const cables = ['vm', 'obd', 'rp', 'p9'].reduce((s, k) => s + (items[k] || 0), 0);
      if (cables > 0) parts.push(`${cables}× Cable`);
      if ((items.stk || 0) > 0) parts.push(`${items.stk}× Stickers`);
      return parts.join(' + ');
    }
  } catch {}
  return `${o.qty}× PT30`;
}

// ─── Order summary / confirmation ─────────────────────────────────────────────

function buildOrderSummary(s, title = '📋 <b>Order Confirmation</b>') {
  let itemsText = '';
  if (s.type === 'fullset') {
    const cableName = CABLE_NAMES[s.cable_type] || s.cable_type || 'Cable';
    const shippingLabel = s.shipping === 'overnight' ? 'Overnight (+$79.99)' : 'Standard (included)';
    itemsText = `🎯 ${s.sets}× Full Set\n  Cable: ${cableName}\n  Stickers: included\n\n🚚 Shipping: ${shippingLabel}\n`;
  } else if (s.type === 'custom') {
    if ((s.items.pt30 || 0) > 0) itemsText += `📱 ${s.items.pt30}× PT30 Device @ $120 = $${(s.items.pt30 * 120).toFixed(2)}\n`;
    for (const [k, name] of Object.entries(CABLE_NAMES)) {
      if ((s.items[k] || 0) > 0) itemsText += `🔌 ${s.items[k]}× ${name} @ $29 = $${(s.items[k] * 29).toFixed(2)}\n`;
    }
    if ((s.items.stk || 0) > 0) itemsText += `🏷 ${s.items.stk}× Stickers @ $9.99 = $${(s.items.stk * 9.99).toFixed(2)}\n`;
    const shippingLabel = s.shipping === 'overnight' ? 'Overnight ($79.99)' : 'Standard ($30.99)';
    itemsText += `\n🚚 Shipping: ${shippingLabel}\n`;
  }
  return (
    `${title}\n\n` +
    `👤 Owner: ${s.owner_name}\n` +
    `🏢 Company: ${s.company_name}\n` +
    `📧 Email: ${s.email}\n` +
    `📱 Phone: ${s.phone}\n` +
    `📍 Delivery: ${s.location}\n\n` +
    itemsText +
    `<b>💰 Total: $${parseFloat(s.total).toFixed(2)}</b>`
  );
}

async function showConfirmation(ctx, session) {
  await ctx.reply(
    buildOrderSummary(session) + '\n\nPlease review and confirm your order:',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm Order', callback_data: 'order_confirm' }],
          [{ text: '✏️ Edit Info',     callback_data: 'order_edit' }],
          [{ text: '❌ Cancel',        callback_data: 'order_cancel' }],
        ],
      },
    }
  );
}

// ─── Shared order session state ───────────────────────────────────────────────
const orderPendingCustomQty = new Map();
const orderSessions = new Map();

// ─── Order: Submenu ───────────────────────────────────────────────────────────

const orderStart = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });

    // Trigger one-time registration if profile is incomplete
    if (!user?.owner_name || !user?.contact_email || !user?.phone || !user?.delivery_address) {
      registrationSessions.set(ctx.from.id, { step: REG_STEPS[0], returnTo: 'order_submenu' });
      return ctx.editMessageText(
        `📝 <b>One-time Profile Setup</b>\n\nBefore placing orders, we need a few details. You only do this <b>once</b> — every future order will be pre-filled automatically!\n\n` + REG_PROMPTS[REG_STEPS[0]],
        { parse_mode: 'HTML' }
      );
    }

    const activeCount = await Order.count({ where: { user_id: user.id, status: 'active' } });
    await ctx.editMessageText(`📦 <b>Device Orders</b>\n\nWhat would you like to do?`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 New Order', callback_data: 'order_new' }],
          [{ text: `📋 Active Orders${activeCount ? ` (${activeCount})` : ''}`, callback_data: 'order_active' }],
          [{ text: '📜 Order History', callback_data: 'order_history_0' }],
          [{ text: '◀️ Back', callback_data: 'main_menu' }],
        ],
      },
    });
  } catch (err) {
    logger.error('orderStart error:', err);
  }
};

// ─── Order: New → Full Set | Custom ──────────────────────────────────────────

const orderNew = async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const ordersOpen = await getSetting('orders_open', 'true');
    if (ordersOpen !== 'true') {
      const msg = await getSetting('orders_closed_message', 'Stores are temporarily unavailable. Please try again later.');
      return ctx.editMessageText(
        `🚫 <b>Orders Unavailable</b>\n\n${msg}`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'order_devices_start' }]] },
        }
      );
    }

    await ctx.editMessageText(
      `📦 <b>New Order</b>\n\nChoose order type:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎯 Full Set', callback_data: 'order_fullset' }],
            [{ text: '🛒 Custom Order', callback_data: 'order_custom' }],
            [{ text: '◀️ Back', callback_data: 'order_devices_start' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('orderNew error:', err);
    await ctx.reply('❌ Error.');
  }
};

// ─── Order: Full Set Flow ─────────────────────────────────────────────────────

const orderFullSet = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `🎯 <b>Full Set</b>\n\n` +
      `Includes: 1× PT30 Device + 1× Cable + Stickers\n` +
      `Standard shipping included\n\n` +
      `Select cable type:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔌 9-Pin', callback_data: 'fs_cable_p9' }],
            [{ text: '⚡ 14-Pin', callback_data: 'fs_cable_rp' }],
            [{ text: '🚐 16-Pin Light Duty', callback_data: 'fs_cable_obd' }],
            [{ text: '🚛 16-Pin Heavy Duty', callback_data: 'fs_cable_vm' }],
            [{ text: '◀️ Back', callback_data: 'order_new' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('orderFullSet error:', err);
    await ctx.reply('❌ Error.');
  }
};

const fsSelectCable = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const cableType = ctx.match[1];

    let session = orderSessions.get(ctx.from.id) || {};
    session = { type: 'fullset', cable_type: cableType };
    orderSessions.set(ctx.from.id, session);

    const cableName = CABLE_NAMES[cableType];
    await ctx.editMessageText(
      `🎯 <b>Full Set — ${cableName}</b>\n\nHow many sets?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [1, 2, 3, 4, 5].map(n => ({ text: String(n), callback_data: `fs_cnt_${n}` })),
            [6, 7, 8, 9].map(n => ({ text: String(n), callback_data: `fs_cnt_${n}` })),
            [{ text: '◀️ Back', callback_data: 'order_fullset' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('fsSelectCable error:', err);
    await ctx.reply('❌ Error.');
  }
};

const fsSelectCount = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const sets = parseInt(ctx.match[1], 10);

    const session = orderSessions.get(ctx.from.id);
    if (!session || session.type !== 'fullset') return ctx.reply('Session expired. Use /start.');
    session.sets = sets;

    const cableName = CABLE_NAMES[session.cable_type];
    const baseTotal  = (sets * PRICES.fullset_base).toFixed(2);
    const ovnTotal   = (sets * PRICES.fullset_base + PRICES.fullset_overnight).toFixed(2);

    await ctx.editMessageText(
      `🎯 <b>Full Set × ${sets}</b>\nCable: ${cableName}\n\nSelect shipping:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `🚚 Standard Shipping (included)`, callback_data: 'fs_shp_s' }],
            [{ text: `🚀 Overnight Shipping`, callback_data: 'fs_shp_o' }],
            [{ text: '◀️ Back', callback_data: 'order_fullset' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('fsSelectCount error:', err);
    await ctx.reply('❌ Error.');
  }
};

const fsSelectShipping = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const shipping = ctx.match[1] === 'o' ? 'overnight' : 'standard';

    const session = orderSessions.get(ctx.from.id);
    if (!session || session.type !== 'fullset') return ctx.reply('Session expired. Use /start.');

    session.shipping = shipping;
    session.total = computeFullSetTotal(session.sets, shipping);

    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    session.company_name    = user?.company_name    || '';
    session.owner_name      = user?.owner_name      || '';
    session.email           = user?.contact_email   || '';
    session.phone           = user?.phone           || '';
    session.location        = user?.delivery_address || '';
    session.step = 'confirmation';

    await ctx.answerCbQuery();
    await showConfirmation(ctx, session);
  } catch (err) {
    logger.error('fsSelectShipping error:', err);
    await ctx.reply('❌ Error.');
  }
};

// ─── Order: Custom Cart Flow ──────────────────────────────────────────────────

async function renderCustomCart(ctx, session) {
  const items = session.items;
  const subtotal = (items.pt30 || 0) * PRICES.pt30 +
    ((items.vm || 0) + (items.obd || 0) + (items.rp || 0) + (items.p9 || 0)) * PRICES.cable +
    (items.stk || 0) * PRICES.sticker;

  let summary = '';
  if (items.pt30 > 0) summary += `📱 ${items.pt30}× PT30 Device\n`;
  for (const [k, n] of Object.entries(CABLE_NAMES)) {
    if ((items[k] || 0) > 0) summary += `🔌 ${items[k]}× ${n}\n`;
  }
  if ((items.stk || 0) > 0) summary += `🏷 ${items.stk}× Stickers\n`;

  const text =
    `🛒 <b>Custom Order</b>\n\n` +
    (summary || 'No items selected yet.\n');

  const keyboard = {
    inline_keyboard: [
      [{ text: `📱 PT30 Device${items.pt30 > 0 ? ` [×${items.pt30}]` : ''}`, callback_data: 'cu_item_pt30' }],
      [{ text: `🔌 9-Pin${items.p9 > 0 ? ` [×${items.p9}]` : ''}`, callback_data: 'cu_item_p9' }],
      [{ text: `⚡ 14-Pin${items.rp > 0 ? ` [×${items.rp}]` : ''}`, callback_data: 'cu_item_rp' }],
      [{ text: `🚐 16-Pin Light Duty${items.obd > 0 ? ` [×${items.obd}]` : ''}`, callback_data: 'cu_item_obd' }],
      [{ text: `🚛 16-Pin Heavy Duty${items.vm > 0 ? ` [×${items.vm}]` : ''}`, callback_data: 'cu_item_vm' }],
      [{ text: `🏷 Stickers${(items.stk || 0) > 0 ? ` [×${items.stk}]` : ''}`, callback_data: 'cu_item_stk' }],
      ...(subtotal > 0 ? [[{ text: '🚚 Select Shipping →', callback_data: 'cu_shipping' }]] : []),
      [{ text: '◀️ Back', callback_data: 'order_new' }],
    ],
  };

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    if (!err.message?.includes('message is not modified')) throw err;
  }
}

const orderCustom = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    let session = orderSessions.get(userId);

    if (!session || session.type !== 'custom' || session.step !== 'cart') {
      session = { type: 'custom', step: 'cart', items: { pt30: 0, vm: 0, obd: 0, rp: 0, p9: 0, stk: 0 } };
      orderSessions.set(userId, session);
    }

    await renderCustomCart(ctx, session);
  } catch (err) {
    logger.error('orderCustom error:', err);
    await ctx.reply('❌ Error.');
  }
};

const cuSelectItem = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const item = ctx.match[1];
    const session = orderSessions.get(ctx.from.id);
    if (!session || session.type !== 'custom') return ctx.reply('Session expired. Use /start.');

    const current = session.items[item] || 0;
    const ITEM_DISPLAY = {
      pt30: '📱 PT30 Device',
      vm:   '🚛 16-Pin Heavy Duty',
      obd:  '🚐 16-Pin Light Duty',
      rp:   '⚡ 14-Pin',
      p9:   '🔌 9-Pin',
      stk:  '🏷 Stickers',
    };

    await ctx.editMessageText(
      `🔢 <b>${ITEM_DISPLAY[item]}</b>\n\nCurrent: <b>${current}</b>\nSelect quantity:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [1, 2, 3, 4, 5].map(n => ({ text: n === current ? `✓${n}` : String(n), callback_data: `cu_qty_${item}_${n}` })),
            [6, 7, 8, 9].map(n => ({ text: n === current ? `✓${n}` : String(n), callback_data: `cu_qty_${item}_${n}` })),
            [{ text: '0 — Remove', callback_data: `cu_qty_${item}_0` }],
            [{ text: '◀️ Back to Cart', callback_data: 'order_custom' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('cuSelectItem error:', err);
    await ctx.reply('❌ Error.');
  }
};

const cuSetQty = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const [, item, qtyStr] = ctx.match;
    const qty = parseInt(qtyStr, 10);

    const session = orderSessions.get(ctx.from.id);
    if (!session || session.type !== 'custom') return ctx.reply('Session expired. Use /start.');

    session.items[item] = qty;
    await renderCustomCart(ctx, session);
  } catch (err) {
    logger.error('cuSetQty error:', err);
    await ctx.reply('❌ Error.');
  }
};

const cuShowShipping = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const session = orderSessions.get(ctx.from.id);
    if (!session || session.type !== 'custom') return ctx.reply('Session expired. Use /start.');

    const items = session.items;
    const subtotal = (items.pt30 || 0) * PRICES.pt30 +
      ((items.vm || 0) + (items.obd || 0) + (items.rp || 0) + (items.p9 || 0)) * PRICES.cable +
      (items.stk || 0) * PRICES.sticker;
    const totalStd = (subtotal + PRICES.ship_standard).toFixed(2);
    const totalOvn = (subtotal + PRICES.ship_overnight).toFixed(2);

    await ctx.editMessageText(
      `🚚 <b>Select Shipping</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `🚚 Standard Shipping`, callback_data: 'cu_ship_s' }],
            [{ text: `🚀 Overnight Shipping`, callback_data: 'cu_ship_o' }],
            [{ text: '◀️ Back to Cart', callback_data: 'order_custom' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('cuShowShipping error:', err);
    await ctx.reply('❌ Error.');
  }
};

const cuSelectShipping = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const shipping = ctx.match[1] === 'o' ? 'overnight' : 'standard';

    const session = orderSessions.get(ctx.from.id);
    if (!session || session.type !== 'custom') return ctx.reply('Session expired. Use /start.');

    session.shipping = shipping;
    session.total = computeCustomTotal(session.items, shipping);

    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    session.company_name    = user?.company_name    || '';
    session.owner_name      = user?.owner_name      || '';
    session.email           = user?.contact_email   || '';
    session.phone           = user?.phone           || '';
    session.location        = user?.delivery_address || '';
    session.step = 'confirmation';

    await ctx.answerCbQuery();
    await showConfirmation(ctx, session);
  } catch (err) {
    logger.error('cuSelectShipping error:', err);
    await ctx.reply('❌ Error.');
  }
};

// ─── Order: Q&A shared handlers ───────────────────────────────────────────────

const orderConfirm = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const session = orderSessions.get(ctx.from.id);
    if (!session) return ctx.reply('Session expired. Please /start again.');

    session.step = 'payment';

    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    const platform = user?.platform || 'leader';
    const zelleName = platform === 'factor' ? 'FACTOR ELD LLC' : 'LEADER ELD LLC';

    await ctx.editMessageText(
      `💳 <b>Payment Required</b>\n\n` +
      `Amount due: <b>$${parseFloat(session.total).toFixed(2)}</b>\n\n` +
      `Please send payment via <b>Zelle</b>:\n` +
      `📲 <code>${zelleName}</code>\n\n` +
      `After payment, send a <b>photo or PDF</b> of your payment screenshot here.`,
      { parse_mode: 'HTML', reply_markup: CANCEL_KB }
    );
  } catch (err) {
    logger.error('orderConfirm error:', err);
    await ctx.reply('❌ Error.');
  }
};

const orderEdit = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const session = orderSessions.get(ctx.from.id);
    if (!session) return ctx.reply('Session expired. Please /start again.');

    registrationSessions.set(ctx.from.id, { step: REG_STEPS[0], returnTo: 'resume_order' });
    await ctx.editMessageText(
      `✏️ <b>Update Your Details</b>\n\nChanges will be saved to your profile and used for all future orders.\n\n` + REG_PROMPTS[REG_STEPS[0]],
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error('orderEdit error:', err);
    await ctx.reply('❌ Error.');
  }
};

const orderCancel = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    orderSessions.delete(ctx.from.id);
    registrationSessions.delete(ctx.from.id);
    await ctx.editMessageText(
      `❌ <b>Order Cancelled</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Orders', callback_data: 'order_devices_start' }]] },
      }
    );
  } catch (err) {
    logger.error('orderCancel error:', err);
    await ctx.reply('Order cancelled.');
  }
};

// ─── Order: Active / History / Detail ─────────────────────────────────────────

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
              text: `📦 #${o.id} — ${orderListLabel(o)} — $${parseFloat(o.total).toFixed(2)} — ${formatDate(o.created_at)}`,
              callback_data: `order_detail_${o.id}`,
            }]),
            [{ text: '◀️ Back', callback_data: 'order_devices_start' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('orderActive error:', err);
    await ctx.reply('❌ Error loading active orders.');
  }
};

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
              const icon = o.status === 'delivered' ? '✅' : '🔄';
              return [{ text: `${icon} #${o.id} — ${orderListLabel(o)} — $${parseFloat(o.total).toFixed(2)} — ${formatDate(o.created_at)}`, callback_data: `order_detail_${o.id}` }];
            }),
            ...(navRow.length ? [navRow] : []),
            [{ text: '◀️ Back', callback_data: 'order_devices_start' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('orderHistory error:', err);
    await ctx.reply('❌ Error loading order history.');
  }
};

const orderDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1], 10);
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const order = await Order.findOne({ where: { id: orderId, user_id: user.id } });
    if (!order) return ctx.editMessageText('Order not found.');

    const statusLine = order.status === 'delivered' ? '✅ <b>Delivered</b>' : '🔄 <b>Active</b> (awaiting delivery)';

    let itemsText = '';
    try {
      const items = JSON.parse(order.items || '{}');
      if (items.type === 'fullset') {
        itemsText = `🎯 ${items.sets}× Full Set\nCable: ${CABLE_NAMES[items.cable_type] || items.cable_type}\nStickers: included\n`;
      } else if (items.type === 'custom') {
        if (items.pt30 > 0) itemsText += `📱 ${items.pt30}× PT30 Device @ $120\n`;
        for (const [k, n] of Object.entries(CABLE_NAMES)) {
          if ((items[k] || 0) > 0) itemsText += `🔌 ${items[k]}× ${n} @ $29\n`;
        }
      } else {
        itemsText = `📦 ${order.qty}× PT30 ELD\n`;
        if (order.cable_pin) itemsText += `🔌 Cable PIN: ${order.cable_pin}\n`;
        if (order.stickers) itemsText += `🏷️ Stickers: ${order.stickers}\n`;
      }
    } catch {
      itemsText = `📦 ${order.qty}× PT30 ELD\n`;
    }

    const shippingLabel = order.shipping === 'overnight' ? 'Overnight (+$79.99)' :
      order.shipping === 'standard' ? 'Standard ($30.99)' : 'Standard (included)';

    const text =
      `📦 <b>Order #${order.id}</b>\n\n` +
      `Status: ${statusLine}\n` +
      `📅 Placed: ${formatDate(order.created_at)}\n\n` +
      `👤 Owner: ${order.owner_name}\n` +
      `🏢 Company: ${order.company_name}\n` +
      `📧 Email: ${order.email}\n` +
      `📱 Phone: ${order.phone}\n` +
      `📍 Delivery: ${order.location}\n\n` +
      itemsText + '\n' +
      `🚚 Shipping: ${shippingLabel}\n` +
      `💰 Total: $${parseFloat(order.total).toFixed(2)}\n\n` +
      (order.tracking_link
        ? `📬 <b>Tracking:</b> <code>${order.tracking_link}</code>`
        : `📬 Tracking: Not available yet`);

    const isUrl = order.tracking_link && order.tracking_link.startsWith('http');
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...(isUrl ? [[{ text: '🔗 Track Package', url: order.tracking_link }]] : []),
          [{ text: '◀️ Back', callback_data: order.status === 'active' ? 'order_active' : 'order_history_0' }],
        ],
      },
    });
  } catch (err) {
    logger.error('orderDetail error:', err);
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
              return [{ text: `${icon} ${formatDate(i.inspection_date)} — ${i.driver_name} — Level ${i.level}`, callback_data: `dot_detail_${i.id}` }];
            }),
            [{ text: '◀️ Back', callback_data: 'main_menu' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('dotMenu error:', err);
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
  } catch (err) {
    logger.error('dotDetail error:', err);
    await ctx.reply('❌ Error loading inspection details.');
  }
};

// ─── Platform selection (after /setapi without prefix) ───────────────────────

const pendingApiSessions = new Map(); // telegram_id → { apiKey, companyName, driversRaw }

const selectPlatform = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const platform = ctx.match[1]; // 'leader' or 'factor'
    const pending = pendingApiSessions.get(ctx.from.id);
    if (!pending) return ctx.editMessageText('Session expired. Please run /setapi again.');

    const { apiKey, companyName, driversRaw } = pending;
    pendingApiSessions.delete(ctx.from.id);

    let user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.editMessageText('Please /start first.');

    await user.update({ company_api_key: apiKey, company_name: companyName, platform });
    user = await User.findOne({ where: { telegram_id: ctx.from.id } });

    const { syncDrivers } = require('./commandHandlers');
    const count = await syncDrivers(user, apiKey, driversRaw);

    const zelleName = platform === 'factor' ? 'FACTOR ELD LLC' : 'LEADER ELD LLC';
    await ctx.editMessageText(
      `✅ Connected${companyName ? ` to <b>${companyName}</b>` : ''}!\n\n` +
      `Platform: <b>${platform === 'factor' ? 'Factor ELD' : 'Leader ELD'}</b>\n` +
      `Zelle payments will go to: <code>${zelleName}</code>\n\n` +
      `Synced <b>${count}</b> driver${count !== 1 ? 's' : ''}. Use /start to open the menu.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error('selectPlatform error:', err);
    await ctx.reply('❌ Error saving platform. Please try /setapi again.');
  }
};

// ─── Referral ────────────────────────────────────────────────────────────────

const referralMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return;

    const mgmtUsername = process.env.MANAGEMENT_BOT_USERNAME || 'OA_Management_Bot';
    const link = `https://t.me/${mgmtUsername}?start=ref_${user.id}`;
    const balance = parseFloat(user.referral_balance || 0).toFixed(2);

    const Referral = require('../models/Referral');
    const [total, confirmed, pending] = await Promise.all([
      Referral.count({ where: { owner_id: user.id } }),
      Referral.count({ where: { owner_id: user.id, status: 'confirmed' } }),
      Referral.count({ where: { owner_id: user.id, status: 'pending' } }),
    ]);

    await ctx.editMessageText(
      `💰 <b>My Referrals</b>\n\n` +
      `🔗 <b>Your Referral Link:</b>\n<code>${link}</code>\n\n` +
      `Share this link with trucking companies who need ELD service. You earn <b>$200</b> for every confirmed referral!\n\n` +
      `💵 Balance: <b>$${balance}</b>\n` +
      `📊 Total referrals: <b>${total}</b>  (✅ ${confirmed} confirmed, ⏳ ${pending} pending)`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `💵 My Balance ($${balance})`, callback_data: 'referral_balance' }],
            [{ text: '📤 Send to Friend', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join Algo Group ELD — best fleet management service! Use my referral link to get started 🚛')}` }],
            [{ text: '📋 Referral History', callback_data: 'referral_history_0' }],
            [{ text: '◀️ Back',             callback_data: 'main_menu' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('referralMenu error:', err);
  }
};

const referralHistory = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1] || 0, 10);
    const PAGE = 5;
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return;

    const Referral = require('../models/Referral');
    const all   = await Referral.findAll({ where: { owner_id: user.id }, order: [['created_at', 'DESC']] });
    const slice = all.slice(page * PAGE, (page + 1) * PAGE);
    const pages = Math.ceil(all.length / PAGE) || 1;

    if (!all.length) {
      return ctx.editMessageText(
        `📋 <b>Referral History</b>\n\nNo referrals yet. Share your link to start earning!`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'referral_menu' }]] } }
      );
    }

    const ICON = { pending: '⏳', confirmed: '✅', rejected: '❌', paid: '💰' };
    const lines = slice.map(r =>
      `${ICON[r.status] || '•'} <b>${r.referred_company || r.referred_name || '?'}</b> — $${parseFloat(r.reward).toFixed(2)} — ${new Date(r.created_at).toLocaleDateString('en-US')}`
    ).join('\n');

    const nav = [];
    if (page > 0)         nav.push({ text: '◀️ Prev', callback_data: `referral_history_${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'Next ▶️', callback_data: `referral_history_${page + 1}` });

    const kb = [];
    if (nav.length) kb.push(nav);
    kb.push([{ text: '◀️ Back', callback_data: 'referral_menu' }]);

    await ctx.editMessageText(
      `📋 <b>Referral History</b> (${all.length} total)\n\n${lines}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
    );
  } catch (err) {
    logger.error('referralHistory error:', err);
  }
};

// ─── Referral Balance ─────────────────────────────────────────────────────────

const referralBalanceMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return;

    const balance = parseFloat(user.referral_balance || 0);
    const balStr  = balance.toFixed(2);

    if (balance <= 0) {
      return ctx.editMessageText(
        `💵 <b>My Balance: $0.00</b>\n\nNo balance yet. Earn <b>$200</b> for every confirmed referral!`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'referral_menu' }]] } }
      );
    }

    const cardLine = user.card_info
      ? `\n💳 Card on file: ••••${user.card_info.replace(/\s/g, '').slice(-4)}`
      : `\n💳 No card on file yet`;

    await ctx.editMessageText(
      `💵 <b>My Balance: $${balStr}</b>${cardLine}\n\nWhat would you like to do with your balance?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 Withdraw to Card',      callback_data: 'ref_withdraw_card' }],
            [{ text: '📦 Cover Service Payment', callback_data: 'ref_cover_service' }],
            [{ text: '💰 Keep for Now',           callback_data: 'referral_menu' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('referralBalanceMenu error:', err);
  }
};

const refWithdrawCard = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return;

    const balance = parseFloat(user.referral_balance || 0);
    if (balance <= 0) {
      return ctx.editMessageText('❌ No balance to withdraw.',
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'referral_menu' }]] } });
    }

    if (!user.card_info) {
      cardSessions.set(ctx.from.id, { purpose: 'withdraw' });
      return ctx.editMessageText(
        `💳 <b>Enter Your Card Number</b>\n\nTo withdraw <b>$${balance.toFixed(2)}</b>, please send your card number:\n\n<i>Example: 4111 1111 1111 1234</i>`,
        { parse_mode: 'HTML' }
      );
    }

    const last4   = user.card_info.replace(/\s/g, '').slice(-4);
    const ownerLabel = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.owner_name || `ID ${user.telegram_id}`;

    await WithdrawalRequest.create({
      owner_id:  user.id,
      amount:    balance,
      card_info: user.card_info,
      status:    'pending',
      source:    'balance',
    });

    const { getAccountingBot } = require('../services/notificationService');
    const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';
    const acctBot = getAccountingBot();
    if (acctBot) {
      try {
        await acctBot.telegram.sendMessage(
          ADMIN_ID,
          `💳 <b>Balance Withdrawal Request</b>\n\nOwner: <b>${ownerLabel}</b>\nCompany: ${user.company_name || '—'}\nAmount: <b>$${balance.toFixed(2)}</b>\nCard: ••••${last4}`,
          { parse_mode: 'HTML' }
        );
      } catch {}
    }

    await ctx.editMessageText(
      `✅ <b>Withdrawal Requested!</b>\n\n<b>$${balance.toFixed(2)}</b> will be sent to your card ending in <b>${last4}</b>.\n\nThe accounting team will process it within 1–2 business days.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'referral_menu' }]] } }
    );
  } catch (err) {
    logger.error('refWithdrawCard error:', err);
  }
};

const refCoverService = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return;

    const balance = parseFloat(user.referral_balance || 0);
    if (balance <= 0) {
      return ctx.editMessageText('❌ No balance to apply.',
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'referral_menu' }]] } });
    }

    const ownerLabel = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.owner_name || `ID ${user.telegram_id}`;
    const { getAccountingBot } = require('../services/notificationService');
    const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';
    const acctBot = getAccountingBot();
    if (acctBot) {
      try {
        await acctBot.telegram.sendMessage(
          ADMIN_ID,
          `📦 <b>Service Cover Request</b>\n\nOwner: <b>${ownerLabel}</b>\nCompany: ${user.company_name || '—'}\nAmount to apply: <b>$${balance.toFixed(2)}</b>`,
          { parse_mode: 'HTML' }
        );
      } catch {}
    }

    await ctx.editMessageText(
      `✅ <b>Request Sent!</b>\n\n<b>$${balance.toFixed(2)}</b> will be applied toward your service payment.\n\nThe accounting team will confirm shortly.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'referral_menu' }]] } }
    );
  } catch (err) {
    logger.error('refCoverService error:', err);
  }
};

// ─── Main Menu / Help ─────────────────────────────────────────────────────────

const mainMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    registrationSessions.delete(ctx.from.id);
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    const hasKey = user && !!user.company_api_key;
    const companyLine = hasKey
      ? `✅ Connected to <b>${user.company_name || 'ELD'}</b>`
      : '⚠️ No company connected. Use /setapi YOUR_COMPANY_KEY';

    await ctx.editMessageText(
      `👋 Welcome to <b>OWNER ASSISTANT BOT</b>\n\nELD Driver Monitoring &amp; Device Orders\n\n${companyLine}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 View Drivers',    callback_data: 'drivers_list' }],
            [{ text: '📦 Order Devices',   callback_data: 'order_devices_start' }],
            [{ text: '🚔 DOT Inspections', callback_data: 'dot_menu' }],
            [{ text: '💰 My Referrals',    callback_data: 'referral_menu' }],
            [{ text: '🔄 Change Team',     callback_data: 'change_team' }],
            [{ text: '❓ Help', callback_data: 'help_menu' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('mainMenu error:', err);
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
  } catch (err) {
    logger.error('changeTeam error:', err);
  }
};

const helpMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `❓ <b>Help</b>\n\n` +
      `/start — Open main menu\n` +
      `/drivers — List all drivers\n` +
      `/setapi KEY — Connect your ELD company\n` +
      `/orders — Order devices\n\n` +
      `<b>How to get your Company API Key:</b>\n` +
      `ELD portal → Settings → API Key → Generate`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'main_menu' }]] },
      }
    );
  } catch (err) {
    logger.error('helpMenu error:', err);
  }
};

module.exports = {
  driverDetails, driverRefresh, driversList, driversListRefresh, driverLocation,
  driversCatShow, driversCatRefresh,
  orderStart, orderNew,
  orderFullSet, fsSelectCable, fsSelectCount, fsSelectShipping,
  orderCustom, cuSelectItem, cuSetQty, cuShowShipping, cuSelectShipping,
  orderConfirm, orderEdit, orderCancel,
  orderActive, orderHistory, orderDetail,
  dotMenu, dotDetail,
  mainMenu, changeTeam, helpMenu,
  referralMenu, referralHistory,
  referralBalanceMenu, refWithdrawCard, refCoverService,
  selectPlatform, pendingApiSessions,
  orderPendingCustomQty, orderSessions,
  ORDER_STEPS: ORDER_QA_STEPS,
  ORDER_PROMPTS: ORDER_QA_PROMPTS,
  CANCEL_KB,
  registrationSessions, REG_STEPS, REG_PROMPTS,
  cardSessions,
  buildOrderSummary, showConfirmation,
};
