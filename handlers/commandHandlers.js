const User = require('../models/User');
const Driver = require('../models/Driver');
const logger = require('../utils/logger');
const { fetchDrivers, fetchDriverStatus, fetchVehicleStatus, fetchCompanyInfo } = require('../services/eldService');

const STATUS_LABELS = {
  'DS_D':   'DRIVING',
  'DS_ON':  'ON DUTY',
  'DS_OFF': 'OFF DUTY',
  'DS_SB':  'SLEEPER BERTH',
  'DS_PC':  'PERSONAL CONVEYANCE',
  'DS_YM':  'YARD MOVE',
};

function mapStatus(code) {
  return STATUS_LABELS[code] || code || 'Unknown';
}

async function syncDrivers(user, companyKey, prefetchedDrivers) {
  const [driversRaw, statusRaw, vehicleRaw] = await Promise.all([
    prefetchedDrivers ? Promise.resolve(prefetchedDrivers) : fetchDrivers(companyKey),
    fetchDriverStatus(companyKey),
    fetchVehicleStatus(companyKey),
  ]);

  // Key by driver_id
  const statusMap = {};
  for (const s of statusRaw) {
    statusMap[String(s.driver_id)] = s;
  }

  const vehicleMap = {};
  for (const v of vehicleRaw) {
    if (v.driver_id) vehicleMap[String(v.driver_id)] = v;
  }

  let count = 0;
  for (const d of driversRaw) {
    const dId = String(d.driver_id || d.id);
    const name = `${d.first_name || ''} ${d.last_name || ''}`.trim() || d.name || d.driver_name || d.username || 'Unknown';
    const st = statusMap[dId] || {};
    const v  = vehicleMap[dId] || {};

    const driverData = {
      user_id:          user.id,
      driver_id:        dId,
      driver_name:      name,
      truck_number:     v.number  || d.truck_number || null,
      eld_provider:     user.company_name || 'ELD',
      current_status:   mapStatus(st.current_status),
      speed:            v.speed   ?? null,
      latitude:         v.lat     ? parseFloat(v.lat) : null,
      longitude:        v.lon     ? parseFloat(v.lon) : null,
      location_string:  v.calc_location || null,
      drive_remaining:  st.drive  ?? null,
      shift_remaining:  st.shift  ?? null,
      break_remaining:  st.break  ?? null,
      cycle_remaining:  st.cycle  ?? null,
      updated_at:       new Date(),
    };

    const existing = await Driver.findOne({ where: { user_id: user.id, driver_id: dId } });
    if (existing) {
      await existing.update(driverData);
    } else {
      await Driver.create(driverData);
    }
    count++;
  }
  return count;
}

const start = async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    let user = await User.findOne({ where: { telegram_id: telegramId } });
    if (!user) {
      user = await User.create({ telegram_id: telegramId });
    } else {
      await user.update({ last_active: new Date() });
    }

    const hasKey = !!user.company_api_key;
    const companyLine = hasKey
      ? `✅ Connected to <b>${user.company_name || 'ELD'}</b>`
      : '⚠️ No company connected. Use /setapi YOUR_COMPANY_KEY';

    await ctx.reply(
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
    logger.error('Start error:', error);
    await ctx.reply('❌ Error. Please try again.');
  }
};

const setapi = async (ctx) => {
  const rawArgs = ctx.message.text.split(' ').slice(1).join('').trim();
  const args = rawArgs.replace(/^(leader|factor)\s*[:_\-]\s*/i, '').trim();

  if (!args) {
    return ctx.reply('Usage: /setapi YOUR_COMPANY_KEY\n\nGet your key from the ELD portal → Settings → API Key');
  }

  let user = await User.findOne({ where: { telegram_id: ctx.from.id } });
  if (!user) return ctx.reply('Please /start first.');

  await ctx.reply('🔄 Connecting to ELD...');

  try {
    const driversRaw = await fetchDrivers(args);

    const info = await fetchCompanyInfo(args);
    const companyName = info?.name || info?.company_name || null;

    await user.update({ company_api_key: args, company_name: companyName });
    user = await User.findOne({ where: { telegram_id: ctx.from.id } });

    logger.info(`User ${ctx.from.id} connected company: ${companyName}`);
    await ctx.reply(`✅ Connected${companyName ? ` to ${companyName}` : ''}!\n\n🔄 Syncing drivers...`);

    const count = await syncDrivers(user, args, driversRaw);
    await ctx.reply(`✅ Synced! Found ${count} driver${count !== 1 ? 's' : ''}.\n\nUse /start to open the menu.`);
  } catch (err) {
    logger.error('setapi error:', err.message);
    await ctx.reply(
      `❌ Connection failed: ${err.message}\n\n` +
      `Make sure your Company API Key is correct.\nGet it from: ELD portal → Settings → API Key`
    );
  }
};

const drivers = async (ctx) => {
  try {
    const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (!user) return ctx.reply('Please /start first.');

    const driverList = await Driver.findAll({ where: { user_id: user.id } });
    if (!driverList.length) {
      return ctx.reply('No drivers found.\n\nConnect your ELD with:\n/setapi YOUR_COMPANY_KEY');
    }

    await ctx.reply(`👥 <b>Your Drivers (${driverList.length})</b>`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: driverList.map((d) => [
          { text: `👤 ${d.driver_name}`, callback_data: `driver_details_${d.driver_id}` },
        ]),
      },
    });
  } catch (error) {
    logger.error('Drivers error:', error);
    await ctx.reply('❌ Error loading drivers.');
  }
};

const help = async (ctx) => {
  await ctx.reply(
    `📖 <b>Owner Assistant Bot Help</b>\n\n` +
    `/start - Open menu\n` +
    `/drivers - View all drivers\n` +
    `/setapi KEY - Connect your company ELD\n` +
    `/orders - Device orders\n` +
    `/help - Show help\n\n` +
    `<b>How to get your Company API Key:</b>\n` +
    `Log in to the ELD portal → Settings → API Key → Generate`,
    { parse_mode: 'HTML' }
  );
};

const orders = async (ctx) => {
  await ctx.reply(
    `📦 <b>Device Orders</b>\n\nPT30 ELD Device:\n• Price: $179\n• Overnight shipping: +$100`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛒 Order PT30 Device', callback_data: 'order_devices_start' }],
        ],
      },
    }
  );
};

module.exports = { start, drivers, help, setapi, orders, syncDrivers };
