const { Op } = require('sequelize');
const Order = require('../models/Order');
const User  = require('../models/User');
const logger = require('../utils/logger');
const { getMainBot } = require('../services/notificationService');
const PDFDocument = require('pdfkit');
const { PassThrough } = require('stream');

const adminSessions = new Map(); // telegram_id → { action, target? }

const USERS_PER_PAGE = 8;

const CABLE_NAMES = {
  vm: '16-Pin Heavy Duty', obd: '16-Pin Light Duty', rp: '14-Pin', p9: '9-Pin',
};

// ─── Keyboards ────────────────────────────────────────────────────────────────

const MAIN_KB = {
  inline_keyboard: [
    [{ text: '👥 Users',       callback_data: 'ha_users_0' }, { text: '📊 Stats',  callback_data: 'ha_stats' }],
    [{ text: '👑 Admin Users', callback_data: 'ha_admins' }],
    [{ text: '📢 Broadcast',   callback_data: 'ha_broadcast' }],
    [{ text: '📄 Report',      callback_data: 'ha_report' }],
  ],
};

const BACK_KB = { inline_keyboard: [[{ text: '◀️ Main Menu', callback_data: 'ha_main' }]] };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userName(u) {
  const n = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return n || u.username || `ID ${u.telegram_id}`;
}

function roleIcon(r) {
  return r === 'owner' ? '👤' : r === 'safety' ? '🛡' : '❓';
}

function platLabel(p) {
  return p === 'leader' ? 'Leader' : p === 'factor' ? 'Factor' : '—';
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function itemsSummary(order) {
  try {
    const it = JSON.parse(order.items || '{}');
    if (it.type === 'fullset') return `${it.sets}× Full Set | ${CABLE_NAMES[it.cable_type] || it.cable_type}`;
    if (it.type === 'custom') {
      const p = [];
      if (it.pt30) p.push(`${it.pt30}× PT30`);
      for (const [k, n] of Object.entries(CABLE_NAMES)) if (it[k]) p.push(`${it[k]}× ${n}`);
      return p.join(', ');
    }
    if (it.type === 'manual') return `${it.qty || 1}× ${it.device || 'Device'} | ${it.cable || ''}`;
  } catch {}
  return `${order.qty || 1}× PT30`;
}

// ─── Main Menu ────────────────────────────────────────────────────────────────

const haStart = async (ctx) => {
  await ctx.reply(
    `🔐 <b>AO Head Admin</b>\n\nWelcome back. Choose a section:`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB }
  );
};

const haMain = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    adminSessions.delete(ctx.from.id);
    await ctx.editMessageText(
      `🔐 <b>AO Head Admin</b>\n\nWelcome back. Choose a section:`,
      { parse_mode: 'HTML', reply_markup: MAIN_KB }
    );
  } catch {}
};

// ─── Stats ────────────────────────────────────────────────────────────────────

const haStats = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const now = new Date();
    const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek  = new Date(startOfDay); startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers, owners, safety, withCompany, blocked,
      leader, factor,
    ] = await Promise.all([
      User.count(),
      User.count({ where: { role: 'owner' } }),
      User.count({ where: { role: 'safety' } }),
      User.count({ where: { company_name: { [Op.not]: null } } }),
      User.count({ where: { blocked: true } }),
      User.count({ where: { platform: 'leader' } }),
      User.count({ where: { platform: 'factor' } }),
    ]);

    await ctx.editMessageText(
      `📊 <b>System Stats</b>\n\n` +
      `<b>👥 Users</b>\n` +
      `• Total: <b>${totalUsers}</b>  (${withCompany} with company)\n` +
      `• Owners: <b>${owners}</b>  |  Safety: <b>${safety}</b>  |  Other: <b>${totalUsers - owners - safety}</b>\n` +
      `• Leader ELD: <b>${leader}</b>  |  Factor ELD: <b>${factor}</b>\n` +
      `• Blocked: <b>${blocked}</b>`,
      { parse_mode: 'HTML', reply_markup: BACK_KB }
    );
  } catch (err) {
    logger.error('haStats error:', err);
  }
};

// ─── Users List ───────────────────────────────────────────────────────────────

const haUsers = async (ctx, page = 0) => {
  try {
    await ctx.answerCbQuery();
    const users = await User.findAll({ order: [['created_at', 'DESC']] });
    const total  = users.length;
    const pages  = Math.ceil(total / USERS_PER_PAGE) || 1;
    const slice  = users.slice(page * USERS_PER_PAGE, (page + 1) * USERS_PER_PAGE);

    // Backfill names for users who have none stored
    const nameless = slice.filter(u => !u.first_name && !u.last_name && !u.username);
    if (nameless.length > 0) {
      const mainBot = getMainBot();
      if (mainBot) {
        await Promise.all(nameless.map(async u => {
          try {
            const chat = await mainBot.telegram.getChat(u.telegram_id);
            const upd = { first_name: chat.first_name || null, last_name: chat.last_name || null, username: chat.username || null };
            await u.update(upd);
            Object.assign(u.dataValues, upd);
          } catch {}
        }));
      }
    }

    const buttons = slice.map(u => [{
      text: `${roleIcon(u.role)} ${userName(u)} — ${u.company_name || 'No company'} [${platLabel(u.platform)}]${u.blocked ? ' 🚫' : ''}`,
      callback_data: `ha_user_${u.id}`,
    }]);

    const nav = [];
    if (page > 0)        nav.push({ text: '◀️ Prev', callback_data: `ha_users_${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'Next ▶️', callback_data: `ha_users_${page + 1}` });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: '◀️ Main Menu', callback_data: 'ha_main' }]);

    await ctx.editMessageText(
      `👥 <b>Users</b>  (${total} total, page ${page + 1}/${pages})\n\n` +
      `${roleIcon('owner')} Owner  ${roleIcon('safety')} Safety  ❓ Unknown  🚫 Blocked`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('haUsers error:', err);
  }
};

// ─── User Detail ──────────────────────────────────────────────────────────────

const haUserDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1], 10);
    const [u, orderCount] = await Promise.all([
      User.findByPk(userId),
      Order.count({ where: { user_id: userId } }),
    ]);
    if (!u) return ctx.editMessageText('❌ User not found.', { reply_markup: BACK_KB });

    const text =
      `👤 <b>${userName(u)}</b>${u.blocked ? '  🚫 <i>BLOCKED</i>' : ''}\n\n` +
      `🆔 Telegram ID: <code>${u.telegram_id}</code>\n` +
      (u.username ? `📎 Username: @${u.username}\n` : '') +
      `🏢 Company: ${u.company_name || '—'}\n` +
      `📧 Email: ${u.contact_email || '—'}\n` +
      `📱 Platform: ${platLabel(u.platform)}\n` +
      `🎭 Role: ${roleIcon(u.role)} ${u.role}\n` +
      `📦 Orders: ${orderCount}\n` +
      `📅 Joined: ${fmtDate(u.created_at)}\n` +
      `🕐 Last active: ${fmtDate(u.last_active)}`;

    const rows = [];
    // Role buttons
    rows.push([
      { text: `${u.role === 'owner'   ? '✅' : ''} Owner`,   callback_data: `ha_role_${userId}_owner` },
      { text: `${u.role === 'safety'  ? '✅' : ''} Safety`,  callback_data: `ha_role_${userId}_safety` },
      { text: `${u.role === 'unknown' ? '✅' : ''} Unknown`, callback_data: `ha_role_${userId}_unknown` },
    ]);
    // Block/unblock
    if (u.blocked) {
      rows.push([{ text: '✅ Unblock User', callback_data: `ha_unblock_${userId}` }]);
    } else {
      rows.push([{ text: '🚫 Block User', callback_data: `ha_block_${userId}` }]);
    }
    rows.push([{ text: '🗑 Delete User', callback_data: `ha_delete_${userId}` }]);
    rows.push([{ text: '◀️ Back to Users', callback_data: 'ha_users_0' }]);

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  } catch (err) {
    logger.error('haUserDetail error:', err);
  }
};

// ─── Set Role ─────────────────────────────────────────────────────────────────

const haSetRole = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1], 10);
    const role   = ctx.match[2];
    await User.update({ role }, { where: { id: userId } });
    // Refresh detail view
    ctx.match[1] = String(userId);
    await haUserDetail(ctx);
  } catch (err) {
    logger.error('haSetRole error:', err);
  }
};

// ─── Block / Unblock ─────────────────────────────────────────────────────────

const haBlock = async (ctx) => {
  try {
    await ctx.answerCbQuery('User blocked.');
    const userId = parseInt(ctx.match[1], 10);
    await User.update({ blocked: true }, { where: { id: userId } });
    ctx.match[1] = String(userId);
    await haUserDetail(ctx);
  } catch (err) {
    logger.error('haBlock error:', err);
  }
};

const haUnblock = async (ctx) => {
  try {
    await ctx.answerCbQuery('User unblocked.');
    const userId = parseInt(ctx.match[1], 10);
    await User.update({ blocked: false }, { where: { id: userId } });
    ctx.match[1] = String(userId);
    await haUserDetail(ctx);
  } catch (err) {
    logger.error('haUnblock error:', err);
  }
};

// ─── Delete User ─────────────────────────────────────────────────────────────

const haDeleteConfirm = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1], 10);
    const u = await User.findByPk(userId);
    if (!u) return ctx.editMessageText('❌ User not found.', { reply_markup: BACK_KB });
    await ctx.editMessageText(
      `🗑 <b>Delete User</b>\n\n` +
      `Are you sure you want to delete <b>${userName(u)}</b>?\n\n` +
      `Their account will be removed from the bot. They won't be blocked — if they send /start again they'll be re-registered as a new user.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Yes, Delete', callback_data: `ha_delete_yes_${userId}` }],
            [{ text: '❌ Cancel', callback_data: `ha_user_${userId}` }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haDeleteConfirm error:', err);
  }
};

const haDeleteUser = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1], 10);
    const u = await User.findByPk(userId);
    const name = u ? userName(u) : `User #${userId}`;
    if (u) await u.update({ deleted_at: new Date(), blocked: true });
    await ctx.editMessageText(
      `✅ <b>${name}</b> has been removed from the bot.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Users', callback_data: 'ha_users_0' }]] } }
    );
  } catch (err) {
    logger.error('haDeleteUser error:', err);
  }
};

// ─── Active Orders ────────────────────────────────────────────────────────────

const haOrders = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orders = await Order.findAll({ where: { status: 'active' }, order: [['created_at', 'DESC']], limit: 25 });
    if (!orders.length) {
      return ctx.editMessageText('📋 <b>Active Orders</b>\n\nNo active orders.', { parse_mode: 'HTML', reply_markup: BACK_KB });
    }

    const buttons = orders.map(o => [{
      text: `#${o.id} ${o.owner_name || '?'} — ${o.company_name || '—'} | ${itemsSummary(o)}`,
      callback_data: `ha_order_${o.id}`,
    }]);
    buttons.push([{ text: '◀️ Main Menu', callback_data: 'ha_main' }]);

    await ctx.editMessageText(
      `📋 <b>Active Orders</b> (${orders.length})`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('haOrders error:', err);
  }
};

const haOrderDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const orderId = parseInt(ctx.match[1], 10);
    const order = await Order.findByPk(orderId);
    if (!order) return ctx.editMessageText('❌ Order not found.', { reply_markup: BACK_KB });

    const text =
      `📦 <b>Order #${order.id}</b>\n\n` +
      `👤 ${order.owner_name || '—'}\n` +
      `🏢 ${order.company_name || '—'}\n` +
      `📧 ${order.email || '—'}\n` +
      `📱 ${order.phone || '—'}\n` +
      `📍 ${order.location || '—'}\n\n` +
      `📦 ${itemsSummary(order)}\n` +
      `🚚 ${order.shipping === 'overnight' ? 'Overnight' : 'Standard'}\n` +
      `💰 $${parseFloat(order.total || 0).toFixed(2)}\n` +
      `📅 ${fmtDate(order.created_at)}\n` +
      (order.tracking_link ? `📬 <a href="${order.tracking_link}">Tracking</a>` : `📬 No tracking yet`);

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Orders', callback_data: 'ha_orders' }]] },
    });
  } catch (err) {
    logger.error('haOrderDetail error:', err);
  }
};

// ─── Broadcast ────────────────────────────────────────────────────────────────

const haBroadcast = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📢 <b>Broadcast Message</b>\n\nChoose who to send to:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📣 All Users',     callback_data: 'ha_bc_all' }],
            [{ text: '👤 Owners Only',   callback_data: 'ha_bc_owner' }, { text: '🛡 Safety Only', callback_data: 'ha_bc_safety' }],
            [{ text: '🔵 Leader ELD',    callback_data: 'ha_bc_leader' }, { text: '🟣 Factor ELD', callback_data: 'ha_bc_factor' }],
            [{ text: '◀️ Cancel',        callback_data: 'ha_main' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haBroadcast error:', err);
  }
};

const haBcTarget = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const target = ctx.match[1]; // all | owner | safety | leader | factor
    const labels = { all: 'All Users', owner: 'Owners', safety: 'Safety Team', leader: 'Leader ELD', factor: 'Factor ELD' };
    adminSessions.set(ctx.from.id, { action: 'broadcast', target });
    await ctx.editMessageText(
      `📢 <b>Broadcast → ${labels[target]}</b>\n\nType your message now and send it.\n\n<i>Use /cancel to abort.</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ha_main' }]] } }
    );
  } catch (err) {
    logger.error('haBcTarget error:', err);
  }
};

// ─── Text handler (broadcast input) ──────────────────────────────────────────

const haHandleText = async (ctx) => {
  const session = adminSessions.get(ctx.from.id);
  if (!session) return;

  // ── Add admin by Telegram ID ─────────────────────────────────────────────
  if (session.action === 'admin_add_id') {
    adminSessions.delete(ctx.from.id);
    const input = ctx.message.text.trim();
    const tgId  = parseInt(input, 10);
    if (!tgId || isNaN(tgId)) {
      return ctx.reply('❌ Invalid Telegram ID. Please enter a numeric ID.', {
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ha_admins' }]] },
      });
    }

    let user = await User.findOne({ where: { telegram_id: tgId } });
    if (!user) {
      // Create a placeholder user so the admin can log in later
      user = await User.create({ telegram_id: tgId, role: session.role });
    } else {
      await user.update({ role: session.role });
    }

    // Try to backfill name from Telegram
    const mainBot = getMainBot();
    if (mainBot && (!user.first_name && !user.username)) {
      try {
        const chat = await mainBot.telegram.getChat(tgId);
        await user.update({ first_name: chat.first_name || null, last_name: chat.last_name || null, username: chat.username || null });
        user = await User.findByPk(user.id);
      } catch {}
    }

    return ctx.reply(
      `✅ <b>${userName(user)}</b> added as <b>${ROLE_LABELS[session.role]}</b>.\n\n` +
      `Telegram ID: <code>${tgId}</code>\n\n` +
      `They can now use their respective bot.`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Admin Users', callback_data: 'ha_admins' }]] },
      }
    );
  }

  if (session.action !== 'broadcast') return;

  adminSessions.delete(ctx.from.id);
  const { target } = session;
  const message = ctx.message.text;

  if (message === '/cancel') {
    return ctx.reply('❌ Broadcast cancelled.', { reply_markup: MAIN_KB });
  }

  // Build where clause
  const where = {};
  if (target === 'owner')  where.role     = 'owner';
  if (target === 'safety') where.role     = 'safety';
  if (target === 'leader') where.platform = 'leader';
  if (target === 'factor') where.platform = 'factor';
  where.blocked = { [Op.not]: true };

  const users = await User.findAll({ where });

  await ctx.reply(`📤 Sending to ${users.length} users…`);

  const mainBot = getMainBot();
  const tg = mainBot ? mainBot.telegram : ctx.telegram;

  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      await tg.sendMessage(u.telegram_id, `📢 <b>Message from Algo Group</b>\n\n${message}`, { parse_mode: 'HTML' });
      sent++;
    } catch {
      failed++;
    }
    // Small delay to avoid flood limits
    await new Promise(r => setTimeout(r, 50));
  }

  await ctx.reply(
    `✅ <b>Broadcast complete</b>\n\nSent: ${sent}  |  Failed: ${failed}`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB }
  );
};

// ─── Report ───────────────────────────────────────────────────────────────────

const haReport = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📄 <b>User Report</b>\n\nSelect report period:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📅 Weekly',   callback_data: 'ha_report_week' }],
            [{ text: '🗓 Monthly',  callback_data: 'ha_report_month' }],
            [{ text: '📆 All Time', callback_data: 'ha_report_all' }],
            [{ text: '◀️ Main Menu', callback_data: 'ha_main' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haReport error:', err);
  }
};

const haGenerateReport = async (ctx) => {
  try {
    await ctx.answerCbQuery('Generating PDF…');
    const period = ctx.match[1]; // week | month | all

    const now = new Date();
    let since = null;
    let periodLabel = '';
    if (period === 'week') {
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      periodLabel = 'Weekly Report (last 7 days)';
    } else if (period === 'month') {
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      periodLabel = 'Monthly Report (last 30 days)';
    } else {
      periodLabel = 'All-Time Report';
    }

    const dateWhere = since ? { [Op.gte]: since } : { [Op.not]: null };

    const [joined, deleted, totalActive, totalBlocked] = await Promise.all([
      User.findAll({
        where: { created_at: dateWhere, deleted_at: null },
        order: [['created_at', 'ASC']],
      }),
      User.findAll({
        where: { deleted_at: dateWhere },
        order: [['deleted_at', 'ASC']],
      }),
      User.count({ where: { deleted_at: null, blocked: { [Op.not]: true } } }),
      User.count({ where: { deleted_at: null, blocked: true } }),
    ]);

    // Build PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = new PassThrough();
    const chunks = [];

    doc.pipe(stream);
    stream.on('data', chunk => chunks.push(chunk));

    const generatedAt = now.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });

    // Header
    doc.fontSize(22).font('Helvetica-Bold').text('AO Head Admin', { align: 'center' });
    doc.fontSize(16).font('Helvetica').text(periodLabel, { align: 'center' });
    doc.fontSize(10).fillColor('#888').text(`Generated: ${generatedAt}`, { align: 'center' });
    doc.moveDown(1.5).fillColor('#000');

    // Summary box
    doc.fontSize(13).font('Helvetica-Bold').text('Summary');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.3).font('Helvetica').fontSize(11);
    doc.text(`New users joined:       ${joined.length}`);
    doc.text(`Users deleted by admin: ${deleted.length}`);
    doc.text(`Total active users:     ${totalActive}`);
    doc.text(`Total blocked users:    ${totalBlocked}`);
    doc.moveDown(1.5);

    // Joined section
    doc.fontSize(13).font('Helvetica-Bold').text(`New Users Joined (${joined.length})`);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.3).font('Helvetica').fontSize(10);

    if (joined.length === 0) {
      doc.fillColor('#888').text('No new users in this period.').fillColor('#000');
    } else {
      joined.forEach((u, i) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `ID ${u.telegram_id}`;
        const company = u.company_name || '—';
        const role = u.role || 'unknown';
        const date = fmtDate(u.created_at);
        doc.text(`${i + 1}. ${name}  |  ${company}  |  Role: ${role}  |  Joined: ${date}`);
      });
    }
    doc.moveDown(1.5);

    // Deleted section
    doc.fontSize(13).font('Helvetica-Bold').text(`Deleted by Admin (${deleted.length})`);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.3).font('Helvetica').fontSize(10);

    if (deleted.length === 0) {
      doc.fillColor('#888').text('No users deleted in this period.').fillColor('#000');
    } else {
      deleted.forEach((u, i) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `ID ${u.telegram_id}`;
        const company = u.company_name || '—';
        const date = fmtDate(u.deleted_at);
        doc.text(`${i + 1}. ${name}  |  ${company}  |  Deleted: ${date}`);
      });
    }

    doc.end();

    await new Promise(resolve => stream.on('end', resolve));
    const pdfBuffer = Buffer.concat(chunks);

    const filename = `report_${period}_${now.toISOString().slice(0, 10)}.pdf`;
    await ctx.replyWithDocument(
      { source: pdfBuffer, filename },
      { caption: `📄 <b>${periodLabel}</b>\n\nJoined: ${joined.length}  |  Deleted: ${deleted.length}  |  Active: ${totalActive}`, parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error('haGenerateReport error:', err);
    await ctx.reply('❌ Failed to generate report.');
  }
};

// ─── Admin Users ─────────────────────────────────────────────────────────────

const ADMIN_ROLES = ['accounting_admin', 'management_admin'];

const ROLE_LABELS = {
  accounting_admin:  '💼 Device Order Admin',
  management_admin:  '📋 Management Admin',
};

const haAdmins = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const admins = await User.findAll({
      where: { role: { [Op.in]: ADMIN_ROLES }, deleted_at: null },
      order: [['role', 'ASC'], ['created_at', 'ASC']],
    });

    const buttons = admins.map(u => [{
      text: `${ROLE_LABELS[u.role] || u.role} — ${userName(u)}${u.blocked ? ' 🚫' : ''}`,
      callback_data: `ha_admin_${u.id}`,
    }]);

    buttons.push([{ text: '➕ Add Admin', callback_data: 'ha_admin_add' }]);
    buttons.push([{ text: '◀️ Main Menu', callback_data: 'ha_main' }]);

    const hint = admins.length === 0
      ? `No admins yet. Tap <b>➕ Add Admin</b> to add one.\n\n`
      : '';

    await ctx.editMessageText(
      `👑 <b>Admin Users</b>  (${admins.length})\n\n` + hint +
      `💼 Device Order Admin — OA Device Order Bot + Website\n` +
      `📋 Management Admin — OA Management Bot`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('haAdmins error:', err);
  }
};

const haAdminDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1], 10);
    const u = await User.findByPk(userId);
    if (!u) return ctx.editMessageText('❌ Admin not found.', { reply_markup: BACK_KB });

    const text =
      `👑 <b>${userName(u)}</b>\n\n` +
      `🆔 Telegram ID: <code>${u.telegram_id}</code>\n` +
      (u.username ? `📎 Username: @${u.username}\n` : '') +
      `🎭 Role: ${ROLE_LABELS[u.role] || u.role}\n` +
      `📅 Added: ${fmtDate(u.created_at)}`;

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: `${u.role === 'accounting_admin' ? '✅' : ''} Device Order`, callback_data: `ha_admin_role_${userId}_accounting_admin` },
            { text: `${u.role === 'management_admin' ? '✅' : ''} Management`,   callback_data: `ha_admin_role_${userId}_management_admin` },
          ],
          [{ text: '🗑 Remove Admin Access', callback_data: `ha_admin_remove_${userId}` }],
          [{ text: '◀️ Back to Admins',      callback_data: 'ha_admins' }],
        ],
      },
    });
  } catch (err) {
    logger.error('haAdminDetail error:', err);
  }
};

const haAdminAdd = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    adminSessions.set(ctx.from.id, { action: 'admin_choose_role' });
    await ctx.editMessageText(
      `➕ <b>Add Admin</b>\n\nWhat type of admin are you adding?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💼 Device Order Admin', callback_data: 'ha_admin_type_accounting_admin' }],
            [{ text: '📋 Management Admin',   callback_data: 'ha_admin_type_management_admin' }],
            [{ text: '❌ Cancel',             callback_data: 'ha_admins' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haAdminAdd error:', err);
  }
};

const haAdminChooseType = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const role = ctx.match[1]; // accounting_admin | management_admin
    adminSessions.set(ctx.from.id, { action: 'admin_add_id', role });
    await ctx.editMessageText(
      `➕ <b>Add ${ROLE_LABELS[role]}</b>\n\nSend their <b>Telegram ID</b> (numeric) now.\n\n` +
      `<i>They must have started the main Owner Assistant Bot at least once, or you can enter their Telegram ID directly.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'ha_admins' }]] },
      }
    );
  } catch (err) {
    logger.error('haAdminChooseType error:', err);
  }
};

const haAdminSetRole = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1], 10);
    const role   = ctx.match[2]; // accounting_admin | management_admin
    await User.update({ role }, { where: { id: userId } });
    ctx.match[1] = String(userId);
    await haAdminDetail(ctx);
  } catch (err) {
    logger.error('haAdminSetRole error:', err);
  }
};

const haAdminRemove = async (ctx) => {
  try {
    await ctx.answerCbQuery('Admin access removed.');
    const userId = parseInt(ctx.match[1], 10);
    await User.update({ role: 'unknown' }, { where: { id: userId } });
    // Return to admin list
    const admins = await User.findAll({
      where: { role: { [Op.in]: ADMIN_ROLES }, deleted_at: null },
      order: [['role', 'ASC'], ['created_at', 'ASC']],
    });
    const buttons = admins.map(u => [{
      text: `${ROLE_LABELS[u.role] || u.role} — ${userName(u)}`,
      callback_data: `ha_admin_${u.id}`,
    }]);
    buttons.push([{ text: '➕ Add Admin', callback_data: 'ha_admin_add' }]);
    buttons.push([{ text: '◀️ Main Menu', callback_data: 'ha_main' }]);
    await ctx.editMessageText(
      `✅ Admin access removed.\n\n👑 <b>Admin Users</b>  (${admins.length})`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('haAdminRemove error:', err);
  }
};

// ─── New order notification ───────────────────────────────────────────────────

async function notifyNewOrder(bot, adminId, order) {
  try {
    await bot.telegram.sendMessage(
      adminId,
      `🆕 <b>New Order #${order.id}</b>\n\n` +
      `👤 ${order.owner_name || '—'}\n` +
      `🏢 ${order.company_name || '—'}\n` +
      `📦 ${itemsSummary(order)}\n` +
      `💰 $${parseFloat(order.total || 0).toFixed(2)}\n` +
      `🏷 ${order.order_type === 'manual' ? 'Manual order' : 'Bot order'}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.warn('Admin new order notify failed:', err.message);
  }
}

module.exports = {
  haStart, haMain,
  haStats,
  haUsers, haUserDetail, haSetRole, haBlock, haUnblock, haDeleteConfirm, haDeleteUser,
  haOrders, haOrderDetail,
  haBroadcast, haBcTarget,
  haReport, haGenerateReport,
  haAdmins, haAdminDetail, haAdminAdd, haAdminChooseType, haAdminSetRole, haAdminRemove,
  haHandleText,
  notifyNewOrder,
  ADMIN_ROLES,
};
