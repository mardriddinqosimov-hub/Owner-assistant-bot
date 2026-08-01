const { Op } = require('sequelize');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Inspection = require('../models/Inspection');
const LinkedCompany = require('../models/LinkedCompany');
const logger = require('../utils/logger');
const { fetchDrivers, fetchDriverStatus, fetchVehicleStatus, fetchHosList, fetchFactorHosList, fetchCompanyInfo, fetchInspections, fetchFmcsaTransfers } = require('../services/eldService');
const notifService = require('../services/notificationService');
const menuTracker = require('../utils/menuTracker');
const { sendMainMenu } = require('../utils/mainMenu');

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
  // One-time migration: wipe legacy rows that have no company_api_key (clean slate on first scoped sync)
  await Driver.destroy({ where: { user_id: user.id, company_api_key: null } }).catch(() => {});

  const factorToken = process.env.FACTOR_SESSION_TOKEN;
  const factorTenantId = process.env.FACTOR_TENANT_ID;
  const isFactorUser = user.platform === 'factor';

  const fetchHos = async () => {
    if (isFactorUser && factorToken && factorTenantId) {
      return fetchFactorHosList(factorToken, factorTenantId);
    }
    const result = await fetchHosList(companyKey);
    if (result === null && factorToken && factorTenantId) {
      // Only auto-set platform if user never explicitly chose one
      if (!user.platform) {
        await user.update({ platform: 'factor' }).catch(() => {});
        logger.info(`syncDrivers: auto-set platform=factor for user ${user.id} (was unset)`);
      }
      return fetchFactorHosList(factorToken, factorTenantId);
    }
    return result ?? [];
  };

  const [driversRaw, statusRaw, vehicleRaw, hosRaw] = await Promise.all([
    prefetchedDrivers ? Promise.resolve(prefetchedDrivers) : fetchDrivers(companyKey),
    fetchDriverStatus(companyKey),
    fetchVehicleStatus(companyKey),
    fetchHos(),
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

  const hosByDriverId = {};
  for (const h of hosRaw) {
    const hId = h.driver_id ?? h.driverId ?? h.id;
    if (hId) hosByDriverId[String(hId)] = h;
  }

  const activeIds = [];
  for (const d of activeDrivers) {
    const dId = String(d.driver_id || d.id);
    activeIds.push(dId);
    const name = `${d.first_name || ''} ${d.last_name || ''}`.trim() || d.name || d.driver_name || d.username || 'Unknown';
    const st = statusMap[dId] || {};
    const hos = hosByDriverId[dId] || {};
    // Try direct driver match first, then cross-ref via vehicle_id on status record
    const v = vehicleByDriverId[dId]
      || (st.vehicle_id ? vehicleByVehicleId[String(st.vehicle_id)] : null)
      || {};

    const existing = await Driver.findOne({ where: { user_id: user.id, company_api_key: companyKey, driver_id: dId } });

    const rawLat = v.lat ?? v.latitude ?? v.gps_lat ?? v.last_lat ?? v.last_latitude
      ?? hos.lat ?? hos.latitude ?? hos.gps_lat ?? hos.gps_latitude
      ?? st.lat ?? st.latitude ?? st.gps_lat
      ?? existing?.latitude;
    const rawLon = v.lon ?? v.lng ?? v.longitude ?? v.gps_lon ?? v.gps_lng ?? v.last_lon ?? v.last_longitude
      ?? hos.lon ?? hos.lng ?? hos.longitude ?? hos.gps_lon ?? hos.gps_lng
      ?? st.lon ?? st.lng ?? st.longitude ?? st.gps_lon
      ?? existing?.longitude;
    const rawSpeed = v.speed ?? v.current_speed ?? st.speed ?? st.current_speed ?? hos.speed;
    const rawTruck = v.number ?? v.truck_number ?? v.vehicle_number
      ?? hos.vehicle_number ?? hos.truck_number ?? hos.number
      ?? st.truck_number ?? st.vehicle_number
      ?? d.truck_number ?? existing?.truck_number;
    const rawLocation = v.calc_location ?? v.location ?? v.address
      ?? hos.calculated_location ?? hos.location ?? hos.address ?? hos.current_location
      ?? st.calc_location ?? st.location ?? st.calc_loc
      ?? existing?.location_string;

    const driverData = {
      user_id:          user.id,
      company_api_key:  companyKey,
      driver_id:        dId,
      driver_name:      name,
      truck_number:     rawTruck || null,
      eld_provider:     user.company_name || 'ELD',
      current_status:   mapStatus(st.current_status ?? st.duty_status ?? st.status ?? st.hos_status ?? st.driver_status),
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

  // Remove drivers that are no longer active (scoped to this company)
  if (activeIds.length > 0) {
    const removed = await Driver.destroy({
      where: { user_id: user.id, company_api_key: companyKey, driver_id: { [Op.notIn]: activeIds } },
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
    } else if (user.deleted_at) {
      // Previously deleted — treat as fresh signup (company already cleared on delete)
      await user.update({ deleted_at: null, last_active: new Date(), ...tgInfo });
      notifService.notifyHeadAdminNewUser(user).catch(() => {});
    } else {
      await user.update({ last_active: new Date(), ...tgInfo });
    }

    const hasKey = !!user.company_api_key;
    const companyLine = hasKey
      ? `✅ Connected to <b>${user.company_name || 'ELD'}</b>`
      : '⚠️ No company connected. Use /setapi YOUR_COMPANY_KEY';

    const keyboard = [];
    if (hasKey) {
      keyboard.push([{ text: `🏢 ${user.company_name || 'My Companies'}  ▾`, callback_data: 'my_companies' }]);
    }
    keyboard.push(
      [{ text: '👥 View Drivers',    callback_data: 'drivers_list' }],
      [{ text: '📦 Order Devices',   callback_data: 'order_devices_start' }],
      [{ text: '🚔 DOT Inspections', callback_data: 'dot_menu' }],
      [{ text: '💰 My Referrals',    callback_data: 'referral_menu' }],
    );
    if (!hasKey) keyboard.push([{ text: '🔄 Change Team', callback_data: 'change_team' }]);
    keyboard.push([{ text: '❓ Help', callback_data: 'help_menu' }]);

    const menuMsg = await ctx.reply(
      `👋 Welcome to <b>OWNER ASSISTANT BOT</b>\n\n` +
      `ELD Driver Monitoring &amp; Device Orders\n\n` +
      `I'll help you monitor your drivers and manage device orders!\n\n` +
      companyLine,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
    );
    menuTracker.set(ctx.from.id, menuMsg.message_id);

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
    // Auto-detect platform: fetchDrivers uses /v2 with X-API-Provider-Key (Leader ELD partner auth).
    // If it succeeds → Leader ELD. If it throws (auth failure) → Factor ELD.
    let driversRaw, info, platform;
    try {
      [driversRaw, info] = await Promise.all([fetchDrivers(args), fetchCompanyInfo(args)]);
      platform = 'leader';
    } catch (detectErr) {
      platform = 'factor';
      driversRaw = [];
      info = null;
      logger.info(`setapi: fetchDrivers failed (${detectErr.message}) — platform=factor for user ${ctx.from.id}`);
    }
    const companyName = info?.name || info?.company_name || null;
    logger.info(`setapi: auto-detected platform=${platform} for user ${ctx.from.id}`);

    if (user.company_api_key && user.company_api_key !== args) {
      await Inspection.destroy({ where: { user_id: user.id } });
      logger.info(`setapi: cleared inspections for user ${user.id} (company switch)`);
    }

    await user.update({ company_api_key: args, company_name: companyName, platform });
    user = await User.findOne({ where: { telegram_id: ctx.from.id } });

    // Save to portfolio so the company switcher knows about it
    LinkedCompany.findOrCreate({
      where: { user_id: user.id, company_api_key: args },
      defaults: { company_name: companyName, platform },
    }).catch(() => {});

    logger.info(`User ${ctx.from.id} connected company: ${companyName} (${platform})`);
    await ctx.reply(`✅ Connected${companyName ? ` to ${companyName}` : ''}!\n\n🔄 Syncing drivers...`);
    const count = await syncDrivers(user, args, driversRaw);
    const syncMsg = platform === 'factor'
      ? `✅ Connected! Driver list will sync automatically.\n\n⚠️ Live driver sync is not available for Factor ELD via this API.`
      : `✅ Synced! Found ${count} driver${count !== 1 ? 's' : ''}.`;
    await ctx.reply(syncMsg, {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Open Menu', callback_data: 'go_main_menu' }]] },
    });
  } catch (err) {
    logger.error('setapi error:', err.message);
    await ctx.reply(
      `❌ Connection failed: ${err.message}\n\n` +
      `Make sure your Company API Key is correct.\nGet it from: ELD portal → Settings → API Key`
    );
  }
};


// ─── DOT Inspection Polling ───────────────────────────────────────────────────

function parseInspField(insp, ...keys) {
  for (const k of keys) if (insp[k] != null) return insp[k];
  return null;
}

async function saveAndNotifyInspection(bot, user, insp, externalId, isFirstSeed = false) {
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
    notified:        isFirstSeed,
    created_at:      new Date(),
  });

  if (isFirstSeed) {
    logger.info(`DOT inspection seeded silently for user ${user.id}: ${externalId}`);
    return;
  }

  const v = record.violations;
  const dateStr = record.inspection_date
    ? new Date(record.inspection_date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
    : 'Unknown date';

  // Delete old menu so notification + fresh menu appear at bottom
  const oldMsgId = menuTracker.get(user.telegram_id);
  if (oldMsgId) {
    try { await bot.telegram.deleteMessage(user.telegram_id, oldMsgId); } catch {}
    menuTracker.del(user.telegram_id);
  }

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

  await sendMainMenu(bot, user.telegram_id);

  await record.update({ notified: true });
  logger.info(`DOT inspection alert sent to user ${user.id}: ${externalId}`);
}

async function saveAndNotifyFmcsaTransfer(bot, user, log, externalId, isFirstSeed = false) {
  const existing = await Inspection.findOne({ where: { user_id: user.id, external_id: externalId } });
  if (existing) return;

  const startDate = log.start_date
    ? new Date(log.start_date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
    : '';
  const endDate = log.end_date
    ? new Date(log.end_date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
    : '';

  const record = await Inspection.create({
    user_id:         user.id,
    driver_id:       log.driver_id || '',
    driver_name:     log.driver_name || 'Unknown Driver',
    external_id:     externalId,
    inspection_date: log.created_at ? new Date(log.created_at) : null,
    report_number:   log.comment || '',
    level:           '',
    violations:      0,
    result:          log.file_status || '',
    details:         JSON.stringify(log),
    notified:        isFirstSeed,
    created_at:      new Date(),
  });

  if (isFirstSeed) {
    logger.info(`FMCSA transfer seeded silently for user ${user.id}: ${externalId}`);
    return;
  }

  const oldMsgId = menuTracker.get(user.telegram_id);
  if (oldMsgId) {
    try { await bot.telegram.deleteMessage(user.telegram_id, oldMsgId); } catch {}
    menuTracker.del(user.telegram_id);
  }

  await bot.telegram.sendMessage(
    user.telegram_id,
    `🚔 <b>DOT Inspection Alert!</b>\n\n` +
    `Driver: <b>${record.driver_name}</b>\n` +
    (startDate && endDate ? `Period: ${startDate} → ${endDate}\n` : '') +
    (record.result ? `Status: ${record.result}\n` : '') +
    (record.report_number ? `Comment: ${record.report_number}\n` : '') +
    `\nView details in <b>DOT Inspections</b> → menu.`,
    { parse_mode: 'HTML' }
  );

  await sendMainMenu(bot, user.telegram_id);
  await record.update({ notified: true });
  logger.info(`FMCSA transfer alert sent to user ${user.id}: ${externalId}`);
}

async function checkNewInspections(bot) {
  const users = await User.findAll({ where: { company_api_key: { [Op.ne]: null } } });

  // Pre-compute which users have no saved records yet — those get seeded silently on first run
  const firstSeedSet = new Set();
  for (const user of users) {
    const count = await Inspection.count({ where: { user_id: user.id } });
    if (count === 0) firstSeedSet.add(user.id);
  }

  // ── FMCSA transfers via Leader ELD session token ────────────────────────────
  const sessionToken = process.env.LEADER_SESSION_TOKEN;
  const tenantId = process.env.LEADER_TENANT_ID;

  if (sessionToken && tenantId) {
    try {
      const logs = await fetchFmcsaTransfers(sessionToken, tenantId);
      logger.info(`checkNewInspections: got ${logs.length} Leader FMCSA transfer records`);

      for (const log of logs) {
        if (!log.id) continue;
        const externalId = `fmcsa-${log.id}`;
        const companyName = (log.company_name || '').toLowerCase().trim();
        const matchedUser = users.find(u =>
          u.platform !== 'factor' &&
          u.company_name && u.company_name.toLowerCase().trim() === companyName
        );
        if (!matchedUser) continue;
        await saveAndNotifyFmcsaTransfer(bot, matchedUser, log, externalId, firstSeedSet.has(matchedUser.id));
      }
    } catch (err) {
      logger.warn('Leader FMCSA transfer check failed:', err.message);
    }
  }

  // ── FMCSA transfers via Factor ELD session token ─────────────────────────────
  const factorToken = process.env.FACTOR_SESSION_TOKEN;
  const factorTenantId = process.env.FACTOR_TENANT_ID;
  const factorMatchedUserIds = new Set();

  if (factorToken && factorTenantId) {
    try {
      const logs = await fetchFmcsaTransfers(factorToken, factorTenantId);
      logger.info(`checkNewInspections: got ${logs.length} Factor FMCSA transfer records`);

      for (const log of logs) {
        if (!log.id) continue;
        const externalId = `fmcsa-factor-${log.id}`;
        const companyName = (log.company_name || '').toLowerCase().trim();
        // Match by company name — no platform filter so null-platform Factor users are covered
        const matchedUser = users.find(u =>
          u.company_name && u.company_name.toLowerCase().trim() === companyName
        );
        if (!matchedUser) continue;
        factorMatchedUserIds.add(matchedUser.id);
        await saveAndNotifyFmcsaTransfer(bot, matchedUser, log, externalId, firstSeedSet.has(matchedUser.id));
      }
    } catch (err) {
      logger.warn('Factor FMCSA transfer check failed:', err.message);
    }
  }

  // ── Legacy per-user inspection check (Leader ELD only) ─────────────────────
  for (const user of users) {
    // Skip Factor users — they get inspections via FMCSA transfers above
    if (user.platform === 'factor' || factorMatchedUserIds.has(user.id)) continue;
    try {
      const inspections = await fetchInspections(user.company_api_key);
      for (const insp of inspections) {
        const externalId = String(
          parseInspField(insp, 'inspection_id', 'inspectionId', 'id', 'dot_inspection_id', 'dotInspectionId') || ''
        );
        if (!externalId) continue;
        await saveAndNotifyInspection(bot, user, insp, `dot-${externalId}`, firstSeedSet.has(user.id));
      }
    } catch (err) {
      logger.warn(`Inspection check failed for user ${user.id}:`, err.message);
    }
  }
}

module.exports = { start, setapi, syncDrivers, checkNewInspections, mapStatus };
