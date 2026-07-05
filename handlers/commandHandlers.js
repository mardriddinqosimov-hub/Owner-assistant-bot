const { Op } = require('sequelize');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Inspection = require('../models/Inspection');
const logger = require('../utils/logger');
const { fetchDrivers, fetchDriverStatus, fetchVehicleStatus, fetchCompanyInfo, fetchInspections, fetchDriverLogEvents } = require('../services/eldService');
const notifService = require('../services/notificationService');

function isActiveDriver(d) {
  if (d.status !== undefined) return String(d.status).toLowerCase() === 'active';
  if (d.is_active !== undefined) return d.is_active === true || d.is_active === 1;
  if (d.active !== undefined) return d.active === true || d.active === 1;
  return true;
}

const STATUS_LABELS = {
  // DS_ prefixed codes (Leader ELD)
  'DS_D':   'DRIVING',
  'DS_ON':  'ON DUTY',
  'DS_OFF': 'OFF DUTY',
  'DS_SB':  'SLEEPER BERTH',
  'DS_PC':  'PERSONAL CONVEYANCE',
  'DS_YM':  'YARD MOVE',
  // Raw short codes
  'D':    'DRIVING',
  'DR':   'DRIVING',
  'ON':   'ON DUTY',
  'OFF':  'OFF DUTY',
  'SB':   'SLEEPER BERTH',
  'PC':   'PERSONAL CONVEYANCE',
  'YM':   'YARD MOVE',
  // Already-mapped full strings (idempotent)
  'DRIVING':            'DRIVING',
  'ON DUTY':            'ON DUTY',
  'OFF DUTY':           'OFF DUTY',
  'SLEEPER BERTH':      'SLEEPER BERTH',
  'PERSONAL CONVEYANCE':'PERSONAL CONVEYANCE',
  'YARD MOVE':          'YARD MOVE',
};

function mapStatus(code) {
  if (!code) return 'OFF DUTY';
  return STATUS_LABELS[String(code).toUpperCase()] || STATUS_LABELS[code] || 'OFF DUTY';
}

async function syncDrivers(user, companyKey, prefetchedDrivers) {
  const [driversRaw, statusRaw, vehicleRaw] = await Promise.all([
    prefetchedDrivers ? Promise.resolve(prefetchedDrivers) : fetchDrivers(companyKey),
    fetchDriverStatus(companyKey),
    fetchVehicleStatus(companyKey),
  ]);

  // Only active drivers
  const activeDrivers = driversRaw.filter(isActiveDriver);

  const statusMap = {};
  for (const s of statusRaw) statusMap[String(s.driver_id)] = s;

  // Index vehicles by every possible ID so we can cross-reference via status
  const vehicleByDriverId   = {};
  const vehicleByVehicleId  = {};
  for (const v of vehicleRaw) {
    if (v.driver_id)          vehicleByDriverId[String(v.driver_id)]   = v;
    if (v.assigned_driver_id) vehicleByDriverId[String(v.assigned_driver_id)] = v;
    const vid = v.vehicle_id ?? v.id;
    if (vid) vehicleByVehicleId[String(vid)] = v;
  }

  const activeIds = [];
  for (const d of activeDrivers) {
    const dId = String(d.driver_id || d.id);
    activeIds.push(dId);
    const name = `${d.first_name || ''} ${d.last_name || ''}`.trim() || d.name || d.driver_name || d.username || 'Unknown';
    const st = statusMap[dId] || {};
    // Try direct driver match first, then cross-ref via vehicle_id on status record
    const v = vehicleByDriverId[dId]
      || (st.vehicle_id ? vehicleByVehicleId[String(st.vehicle_id)] : null)
      || {};

    // Fallback to status record fields if vehicle record is empty
    const rawLat = v.lat ?? v.latitude ?? v.gps_lat ?? st.lat ?? st.latitude;
    const rawLon = v.lon ?? v.lng ?? v.longitude ?? v.gps_lon ?? st.lon ?? st.lng ?? st.longitude;
    const rawSpeed = v.speed ?? v.current_speed ?? st.speed ?? st.current_speed;
    const rawTruck = v.number ?? v.truck_number ?? v.vehicle_number ?? st.truck_number ?? st.vehicle_number ?? d.truck_number;
    const rawLocation = v.calc_location ?? v.location ?? v.address ?? st.calc_location ?? st.location;

    const existing = await Driver.findOne({ where: { user_id: user.id, driver_id: dId } });

    const driverData = {
      user_id:          user.id,
      driver_id:        dId,
      driver_name:      name,
      truck_number:     rawTruck || null,
      eld_provider:     user.company_name || 'ELD',
      current_status:   mapStatus(st.current_status ?? st.duty_status ?? st.status ?? st.hos_status ?? st.driver_status),
      // Never use cached GPS — stale coordinates are worse than no coordinates
      speed:            rawSpeed ?? null,
      latitude:         rawLat ? parseFloat(rawLat) : null,
      longitude:        rawLon ? parseFloat(rawLon) : null,
      location_string:  rawLocation ?? null,
      drive_remaining:  st.drive  ?? null,
      shift_remaining:  st.shift  ?? null,
      break_remaining:  st.break  ?? null,
      cycle_remaining:  st.cycle  ?? null,
      updated_at:       new Date(),
    };

    if (existing) {
      await existing.update(driverData);
    } else {
      await Driver.create(driverData);
    }
  }

  // Remove drivers that are no longer active
  if (activeIds.length > 0) {
    const removed = await Driver.destroy({
      where: { user_id: user.id, driver_id: { [Op.notIn]: activeIds } },
    });
    if (removed > 0) logger.info(`Removed ${removed} inactive driver(s) for user ${user.id}`);
  }

  return activeIds.length;
}

const start = async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const tgInfo = {
      first_name: ctx.from.first_name || null,
      last_name:  ctx.from.last_name  || null,
      username:   ctx.from.username   || null,
    };
    let user = await User.findOne({ where: { telegram_id: telegramId } });
    if (!user) {
      user = await User.create({ telegram_id: telegramId, role: 'owner', ...tgInfo });
      notifService.notifyHeadAdminNewUser(user).catch(() => {});
    } else {
      await user.update({ last_active: new Date(), ...tgInfo });
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
            [{ text: '👥 View Drivers',    callback_data: 'drivers_list' }],
            [{ text: '📦 Order Devices',   callback_data: 'order_devices_start' }],
            [{ text: '🚔 DOT Inspections', callback_data: 'dot_menu' }],
            [{ text: '💰 My Referrals',    callback_data: 'referral_menu' }],
            [{ text: '🛠️ Special Task',    callback_data: 'special_task_menu' }],
            [{ text: '🔄 Change Team',     callback_data: 'change_team' }],
            [{ text: '❓ Help',            callback_data: 'help_menu' }],
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
  const platformMatch = rawArgs.match(/^(leader|factor)\s*[:_\-]\s*/i);
  const platform = platformMatch ? platformMatch[1].toLowerCase() : null;
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

    if (platform) {
      // Platform was specified in the command — finish immediately
      const updateData = { company_api_key: args, company_name: companyName, platform };
      await user.update(updateData);
      user = await User.findOne({ where: { telegram_id: ctx.from.id } });

      logger.info(`User ${ctx.from.id} connected company: ${companyName} (${platform})`);
      await ctx.reply(`✅ Connected${companyName ? ` to ${companyName}` : ''}!\n\n🔄 Syncing drivers...`);
      const count = await syncDrivers(user, args, driversRaw);
      await ctx.reply(`✅ Synced! Found ${count} driver${count !== 1 ? 's' : ''}.\n\nUse /start to open the menu.`);
    } else {
      // No platform prefix — ask user to pick
      const { pendingApiSessions } = require('./callbackHandlers');
      pendingApiSessions.set(ctx.from.id, { apiKey: args, companyName, driversRaw });

      await ctx.reply(
        `✅ Connected${companyName ? ` to <b>${companyName}</b>` : ''}!\n\n` +
        `Which ELD platform is this company on?\n\n` +
        `This determines your <b>Zelle payment recipient</b>.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Leader ELD', callback_data: 'platform_select_leader' },
                { text: 'Factor ELD', callback_data: 'platform_select_factor' },
              ],
            ],
          },
        }
      );
    }
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

// ─── DOT Inspection Polling ───────────────────────────────────────────────────

function parseInspField(insp, ...keys) {
  for (const k of keys) if (insp[k] != null) return insp[k];
  return null;
}

async function saveAndNotifyInspection(bot, user, insp, externalId) {
  const existing = await Inspection.findOne({ where: { user_id: user.id, external_id: externalId } });
  if (existing) return;

  const rawDate = parseInspField(insp,
    'inspection_date', 'inspectionDate', 'date', 'event_time', 'eventTime', 'start_time', 'startTime');
  const driverName = parseInspField(insp,
    'driver_name', 'driverName', 'driver', 'name') || 'Unknown Driver';
  const driverId = String(parseInspField(insp, 'driver_id', 'driverId', 'driver_id') || '');
  const reportNum = parseInspField(insp, 'report_number', 'reportNumber', 'report_id', 'reportId') || '';
  const level = String(parseInspField(insp, 'level', 'inspection_level', 'inspectionLevel') || '');
  const violations = parseInt(parseInspField(insp, 'violations', 'violation_count', 'violationCount') || 0, 10);
  const result = parseInspField(insp, 'result', 'outcome', 'inspection_result', 'inspectionResult') || '';

  const record = await Inspection.create({
    user_id:         user.id,
    driver_id:       driverId,
    driver_name:     driverName,
    external_id:     externalId,
    inspection_date: rawDate ? new Date(rawDate) : null,
    report_number:   reportNum,
    level,
    violations,
    result,
    details:         JSON.stringify(insp),
    notified:        false,
    created_at:      new Date(),
  });

  const v = record.violations;
  const dateStr = record.inspection_date
    ? new Date(record.inspection_date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
    : 'Unknown date';

  await bot.telegram.sendMessage(
    user.telegram_id,
    `🚔 <b>DOT Inspection Alert!</b>\n\n` +
    `Driver: <b>${record.driver_name}</b>\n` +
    `Date: ${dateStr}\n` +
    (record.report_number ? `Report #: ${record.report_number}\n` : '') +
    (record.level ? `Level: ${record.level}\n` : '') +
    `Violations: ${v} ${v > 0 ? '⚠️' : '✅'}\n` +
    (record.result ? `Result: ${record.result.toUpperCase()}\n` : '') +
    `\nView details in <b>DOT Inspections</b> → menu.`,
    { parse_mode: 'HTML' }
  );

  await record.update({ notified: true });
  logger.info(`DOT inspection alert sent to user ${user.id}: ${externalId}`);
}

async function checkNewInspections(bot) {
  const users = await User.findAll({ where: { company_api_key: { [Op.ne]: null } } });

  for (const user of users) {
    try {
      // ── Primary: /dot-inspections endpoint ──────────────────────────────────
      const inspections = await fetchInspections(user.company_api_key);
      logger.info(`checkNewInspections: user ${user.id} got ${inspections.length} records from /dot-inspections`);

      for (const insp of inspections) {
        const externalId = String(
          parseInspField(insp, 'inspection_id', 'inspectionId', 'id', 'dot_inspection_id', 'dotInspectionId') || ''
        );
        if (!externalId) continue;
        await saveAndNotifyInspection(bot, user, insp, `dot-${externalId}`);
      }

      // ── Fallback: scan driver log events for "DOT Inspection" notes ─────────
      const events = await fetchDriverLogEvents(user.company_api_key, 2);
      logger.info(`checkNewInspections: user ${user.id} got ${events.length} log events`);

      for (const ev of events) {
        const notes = String(
          parseInspField(ev, 'notes', 'note', 'comment', 'annotation', 'description') || ''
        ).toLowerCase();
        if (!notes.includes('dot inspection') && !notes.includes('dot_inspection')) continue;

        // Build a stable external_id from event sequence id or time+driver
        const seqId = parseInspField(ev, 'id', 'seq_id', 'seqId', 'sequence_id', 'event_id', 'eventId');
        const evTime = parseInspField(ev, 'event_time', 'eventTime', 'start_time', 'startTime', 'date', 'created_at');
        const evDriver = parseInspField(ev, 'driver_id', 'driverId') || 'unknown';
        const externalId = seqId
          ? `event-${seqId}`
          : `event-${evDriver}-${evTime ? new Date(evTime).getTime() : Date.now()}`;

        await saveAndNotifyInspection(bot, user, ev, externalId);
      }
    } catch (err) {
      logger.warn(`Inspection check failed for user ${user.id}:`, err.message);
    }
  }
}

module.exports = { start, drivers, help, setapi, orders, syncDrivers, checkNewInspections };
