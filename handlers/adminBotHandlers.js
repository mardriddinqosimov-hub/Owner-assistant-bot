const { Op } = require('sequelize');
const Order = require('../models/Order');
const User  = require('../models/User');
const Driver = require('../models/Driver');
const logger = require('../utils/logger');
const { getMainBot } = require('../services/notificationService');
const PDFDocument = require('pdfkit');
const { PassThrough } = require('stream');

const adminSessions = new Map(); // telegram_id → { action, target? }

const USERS_PER_PAGE = 8;

const BLOCKS = [
  { key: 'a',        label: '🟢 A block',   short: '🟢A' },
  { key: 'd',        label: '🟣 D block',   short: '🟣D' },
  { key: 'texas',    label: '🔴 Texas',     short: '🔴TX' },
  { key: 'missouri', label: '⚪️ Missouri',  short: '⚪️MO' },
  { key: 'first_a',  label: '🔵 First-A',  short: '🔵FA' },
  { key: 'first_b',  label: '🟤 First-B',  short: '🟤FB' },
  { key: 'a1',       label: '🟡 A1',        short: '🟡A1' },
  { key: 'b1',       label: '🟠 B1',        short: '🟠B1' },
  { key: 'c1',       label: '⚫️ C1',        short: '⚫️C1' },
];

const CABLE_NAMES = {
  vm: '16-Pin Heavy Duty', obd: '16-Pin Light Duty', rp: '14-Pin', p9: '9-Pin',
};

// ─── Keyboards ────────────────────────────────────────────────────────────────

const MAIN_KB = {
  inline_keyboard: [
    [{ text: '👥 Users',       callback_data: 'ha_users' }, { text: '📊 Stats',  callback_data: 'ha_stats' }],
    [{ text: '🏷 Blocks',      callback_data: 'ha_blocks' }],
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

function blockLabel(key) {
  const b = BLOCKS.find(b => b.key === key);
  return b ? b.label : '—';
}

function blockShort(key) {
  const b = BLOCKS.find(b => b.key === key);
  return b ? b.short : '—';
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

    const SupportTask = require('../models/SupportTask');

    const [
      totalUsers, owners, safety, withCompany, blocked, leader, factor,
      totalTasks, openTasks, closedTasks, allClosed,
    ] = await Promise.all([
      User.count(),
      User.count({ where: { role: 'owner' } }),
      User.count({ where: { role: 'safety' } }),
      User.count({ where: { company_name: { [Op.not]: null } } }),
      User.count({ where: { blocked: true } }),
      User.count({ where: { platform: 'leader' } }),
      User.count({ where: { platform: 'factor' } }),
      SupportTask.count(),
      SupportTask.count({ where: { status: { [Op.in]: ['pending', 'in_process', 'awaiting_approval'] } } }),
      SupportTask.count({ where: { status: 'closed' } }),
      SupportTask.findAll({ where: { status: 'closed', claimed_at: { [Op.not]: null }, closed_at: { [Op.not]: null } } }),
    ]);

    const fmtMs = ms => {
      const s = Math.round(ms / 1000);
      if (s < 60)   return `${s}s`;
      if (s < 3600) return `${Math.round(s / 60)}m`;
      return `${(s / 3600).toFixed(1)}h`;
    };
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    const memberMap = {};
    for (const t of allClosed) {
      const key = t.claimed_by || 'Unknown';
      if (!memberMap[key]) memberMap[key] = { claimMs: [], resolveMs: [], count: 0 };
      memberMap[key].count++;
      if (t.claimed_at) memberMap[key].claimMs.push(new Date(t.claimed_at) - new Date(t.created_at));
      if (t.closed_at)  memberMap[key].resolveMs.push(new Date(t.closed_at) - new Date(t.created_at));
    }

    let memberLines = '';
    for (const [name, d] of Object.entries(memberMap)) {
      const claim   = avg(d.claimMs);
      const resolve = avg(d.resolveMs);
      memberLines += `\n  • <b>${name}</b> — ${d.count} cases`;
      if (claim)   memberLines += ` | claim: ${fmtMs(claim)}`;
      if (resolve) memberLines += ` | resolve: ${fmtMs(resolve)}`;
    }

    await ctx.editMessageText(
      `📊 <b>System Stats</b>\n\n` +
      `<b>👥 Users</b>\n` +
      `• Total: <b>${totalUsers}</b>  (${withCompany} with company)\n` +
      `• Owners: <b>${owners}</b>  |  Safety: <b>${safety}</b>  |  Other: <b>${totalUsers - owners - safety}</b>\n` +
      `• Leader ELD: <b>${leader}</b>  |  Factor ELD: <b>${factor}</b>\n` +
      `• Blocked: <b>${blocked}</b>\n\n` +
      `<b>🎧 Support</b>\n` +
      `• Total cases: <b>${totalTasks}</b>  |  Open: <b>${openTasks}</b>  |  Closed: <b>${closedTasks}</b>` +
      (memberLines ? `\n\n<b>👤 Per Member (closed cases)</b>${memberLines}` : ''),
      { parse_mode: 'HTML', reply_markup: BACK_KB }
    );
  } catch (err) {
    logger.error('haStats error:', err);
  }
};

// ─── Users List ───────────────────────────────────────────────────────────────

const haUsersMenu = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const [owners, safety, unknown, blocked] = await Promise.all([
      User.count({ where: { role: 'owner',  blocked: { [Op.not]: true }, deleted_at: null } }),
      User.count({ where: { role: 'safety', blocked: { [Op.not]: true }, deleted_at: null } }),
      User.count({ where: { role: { [Op.notIn]: ['owner', 'safety'] }, blocked: { [Op.not]: true }, deleted_at: null } }),
      User.count({ where: { blocked: true } }),
    ]);
    await ctx.editMessageText(
      `👥 <b>Users</b>\n\nChoose a group to view:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `👤 Owners (${owners})`,   callback_data: 'ha_ulist_owner_0' }],
            [{ text: `🛡 Safety (${safety})`,    callback_data: 'ha_ulist_safety_0' }],
            [{ text: `❓ Unknown (${unknown})`,  callback_data: 'ha_ulist_unknown_0' }],
            [{ text: `🚫 Blocked (${blocked})`,  callback_data: 'ha_ulist_blocked_0' }],
            [{ text: '◀️ Main Menu', callback_data: 'ha_main' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haUsersMenu error:', err);
  }
};

const haUsers = async (ctx, filter = 'owner', page = 0) => {
  try {
    await ctx.answerCbQuery();

    const filterWhere =
      filter === 'owner'   ? { role: 'owner',  blocked: { [Op.not]: true }, deleted_at: null } :
      filter === 'safety'  ? { role: 'safety', blocked: { [Op.not]: true }, deleted_at: null } :
      filter === 'blocked' ? { blocked: true } :
      /* unknown */          { role: { [Op.notIn]: ['owner', 'safety'] }, blocked: { [Op.not]: true }, deleted_at: null };

    const filterLabel =
      filter === 'owner'   ? '👤 Owners' :
      filter === 'safety'  ? '🛡 Safety' :
      filter === 'blocked' ? '🚫 Blocked' :
      '❓ Unknown';

    const users = await User.findAll({ where: filterWhere, order: [['created_at', 'DESC']] });
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
      text: `${roleIcon(u.role)} ${userName(u)} — ${u.company_name || 'No company'} [${platLabel(u.platform)}] [${blockShort(u.block)}]${u.blocked ? ' 🚫' : ''}`,
      callback_data: `ha_user_${u.id}`,
    }]);

    const nav = [];
    if (page > 0)          nav.push({ text: '◀️ Prev', callback_data: `ha_ulist_${filter}_${page - 1}` });
    if (page < pages - 1)  nav.push({ text: 'Next ▶️', callback_data: `ha_ulist_${filter}_${page + 1}` });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: '◀️ Back to Users', callback_data: 'ha_users' }]);

    await ctx.editMessageText(
      `${filterLabel}  <b>(${total} total, page ${page + 1}/${pages})</b>`,
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
      `🏷 Block: ${blockLabel(u.block)}\n` +
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
    // Assign block
    rows.push([{ text: `🏷 Assign Block${u.block ? ` (${blockShort(u.block)})` : ''}`, callback_data: `ha_assign_block_${userId}` }]);
    // Block/unblock
    if (u.blocked) {
      rows.push([{ text: '✅ Unblock User', callback_data: `ha_unblock_${userId}` }]);
    } else {
      rows.push([{ text: '🚫 Block User', callback_data: `ha_block_${userId}` }]);
    }
    rows.push([{ text: '🗑 Delete User', callback_data: `ha_delete_${userId}` }]);
    rows.push([{ text: '◀️ Back to Users', callback_data: 'ha_users' }]);

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
    if (u) {
      await Driver.destroy({ where: { user_id: u.id } });
      await u.update({
        deleted_at:      new Date(),
        company_api_key: null,
        company_name:    null,
        platform:        null,
        blocked:         false,
      });
    }
    await ctx.editMessageText(
      `✅ <b>${name}</b> has been removed from the bot.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Users', callback_data: 'ha_users' }]] } }
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

  // ── Add member — step 1: nickname ───────────────────────────────────────────
  if (session.action === 'member_add_name') {
    const name = ctx.message.text.trim();
    if (!name) return ctx.reply('⚠️ Nickname cannot be empty. Try again:');
    adminSessions.set(ctx.from.id, { action: 'member_add_member_id', name, block: session.block });
    return ctx.reply(
      `✅ Nickname: <b>${name}</b>\n\nStep 2 of 2\n\nNow enter their <b>Member ID</b>:\n<i>(e.g. MO01)</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `ha_team_members_${session.block}` }]] } }
    );
  }

  // ── Add member — step 2: member ID ──────────────────────────────────────────
  if (session.action === 'member_add_member_id') {
    adminSessions.delete(ctx.from.id);
    const memberId = ctx.message.text.trim();
    const blockKey = session.block;
    const blockInfo = BLOCKS.find(b => b.key === blockKey);
    if (!memberId) return ctx.reply('⚠️ Member ID cannot be empty.');
    const SupportMember = require('../models/SupportMember');
    try {
      await SupportMember.create({ name: session.name, member_id: memberId, block: blockKey });
      return ctx.reply(
        `✅ <b>${session.name}  —  #${memberId}</b> added to <b>${blockInfo?.label || blockKey}</b>!\n\nThey'll appear on claim buttons for owners in this block.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '👤 Team Members', callback_data: `ha_team_members_${blockKey}` }]] } }
      );
    } catch (err) {
      const isDupe = err.name === 'SequelizeUniqueConstraintError';
      return ctx.reply(
        isDupe
          ? `❌ Member ID <b>#${memberId}</b> is already taken. Please use a different ID.`
          : `❌ Failed to add member: ${err.message}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Team Members', callback_data: `ha_team_members_${blockKey}` }]] } }
      );
    }
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
  if (target === 'owner')  where.role     = { [Op.in]: ['owner', 'unknown'] };
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
      await tg.sendMessage(
        u.telegram_id,
        `🚨🚨🚨 <b>IMPORTANT NOTICE</b> 🚨🚨🚨\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📣 <b>Message from Algo Group:</b>\n\n` +
        `${message}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⚠️ <i>Please read carefully and take action if needed.</i>`,
        { parse_mode: 'HTML' }
      );
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

// PDFKit only supports Latin-1 in built-in fonts — fall back to @username or TG ID for non-ASCII names
function safePdfName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
  if (full && !/[^\x00-\x7F]/.test(full)) return full;
  if (u.username) return `@${u.username}`;
  return `TG:${u.telegram_id}`;
}

function roleLabel(role) {
  const map = {
    owner: 'Owner',
    safety: 'Safety',
    accounting_admin: 'Acctg Admin',
    management_admin: 'Mgmt Admin',
  };
  return map[role] || role || '—';
}

function platformLabel(p) {
  if (!p) return '—';
  if (p === 'leader') return 'Leader ELD';
  if (p === 'factor') return 'Factor ELD';
  return p;
}

function pdfSection(doc, title) {
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a2e').text(title.toUpperCase());
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor('#3a86ff').lineWidth(1.5).stroke();
  doc.moveDown(0.5).font('Helvetica').fontSize(9.5).fillColor('#000').lineWidth(1);
}

function pdfRow(doc, cols, widths, x0 = 50) {
  let x = x0;
  cols.forEach((text, i) => {
    doc.text(String(text || '—'), x, doc.y, { width: widths[i] - 4, lineBreak: false, ellipsis: true });
    x += widths[i];
  });
  doc.moveDown(0.6);
}

const haReport = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `📄 <b>Report</b>\n\nStep 1 — Select period:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📅 Weekly (last 7 days)',   callback_data: 'ha_rperiod_week' }],
            [{ text: '🗓 Monthly (last 30 days)',  callback_data: 'ha_rperiod_month' }],
            [{ text: '📆 All Time',               callback_data: 'ha_rperiod_all' }],
            [{ text: '◀️ Main Menu', callback_data: 'ha_main' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haReport error:', err);
  }
};

const haReportAudience = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const period = ctx.match[1];
    const periodText = period === 'week' ? 'Weekly' : period === 'month' ? 'Monthly' : 'All-Time';
    await ctx.editMessageText(
      `📄 <b>Report — ${periodText}</b>\n\nStep 2 — Select who to include:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '👥 All Users',              callback_data: `ha_rgen_${period}_all` }],
            [{ text: '👤 Owners Only',            callback_data: `ha_rgen_${period}_owners` }],
            [{ text: '👤👷 Owners + Safety',      callback_data: `ha_rgen_${period}_ownersafe` }],
            [{ text: '◀️ Back', callback_data: 'ha_report' }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haReportAudience error:', err);
  }
};

const haGenerateReport = async (ctx) => {
  try {
    await ctx.answerCbQuery('Generating PDF…');
    const period   = ctx.match[1]; // week | month | all
    const audience = ctx.match[2]; // all | owners | ownersafe

    const now = new Date();
    let since = null;
    let periodLabel = '';
    if (period === 'week') {
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      periodLabel = 'Weekly Report — Last 7 Days';
    } else if (period === 'month') {
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      periodLabel = 'Monthly Report — Last 30 Days';
    } else {
      periodLabel = 'All-Time Report';
    }

    const audienceLabel = audience === 'owners' ? 'Owners Only'
      : audience === 'ownersafe' ? 'Owners & Safety'
      : 'All Users';

    const dateWhere  = since ? { [Op.gte]: since } : { [Op.not]: null };

    // Role filter for "joined" query
    const roleFilter = audience === 'owners'
      ? { role: 'owner' }
      : audience === 'ownersafe'
        ? { role: { [Op.in]: ['owner', 'safety'] } }
        : {};

    const [joined, deleted, totalActive, totalBlocked, totalOwners, totalSafety] = await Promise.all([
      User.findAll({
        where: { created_at: dateWhere, deleted_at: null, ...roleFilter },
        order: [['created_at', 'ASC']],
      }),
      User.findAll({
        where: { deleted_at: dateWhere, ...roleFilter },
        order: [['deleted_at', 'ASC']],
      }),
      User.count({ where: { deleted_at: null, blocked: { [Op.not]: true }, ...roleFilter } }),
      User.count({ where: { deleted_at: null, blocked: true } }),
      User.count({ where: { deleted_at: null, role: 'owner' } }),
      User.count({ where: { deleted_at: null, role: 'safety' } }),
    ]);

    // ── Build PDF ──────────────────────────────────────────────────────────────
    const doc    = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = new PassThrough();
    const chunks = [];
    doc.pipe(stream);
    stream.on('data', c => chunks.push(c));

    const generatedAt = now.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Chicago' });

    // Header
    doc.rect(50, 40, 495, 70).fill('#1a1a2e');
    doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
       .text('OWNER ASSISTANT BOT', 50, 55, { align: 'center', width: 495 });
    doc.fontSize(11).font('Helvetica')
       .text(periodLabel, 50, 78, { align: 'center', width: 495 });
    doc.fillColor('#000').moveDown(2.5);

    doc.fontSize(9).fillColor('#555')
       .text(`Generated: ${generatedAt}  |  Filter: ${audienceLabel}`, { align: 'center' });
    doc.fillColor('#000').moveDown(1.5);

    // Summary
    pdfSection(doc, 'Summary');
    const summaryY = doc.y;
    doc.fontSize(10);
    doc.text(`New users (this period):`, 50, summaryY);      doc.text(String(joined.length),   250, summaryY);
    doc.text(`Deleted (this period):`,   50, summaryY + 16); doc.text(String(deleted.length),  250, summaryY + 16);
    doc.text(`Total active users:`,      50, summaryY + 32); doc.text(String(totalActive),     250, summaryY + 32);
    doc.text(`Total blocked users:`,     50, summaryY + 48); doc.text(String(totalBlocked),    250, summaryY + 48);
    doc.text(`Total owners:`,            320, summaryY);     doc.text(String(totalOwners),     460, summaryY);
    doc.text(`Total safety:`,            320, summaryY + 16);doc.text(String(totalSafety),     460, summaryY + 16);
    doc.y = summaryY + 72;
    doc.moveDown(1);

    // New Users table
    pdfSection(doc, `New Users Joined (${joined.length})`);
    if (joined.length === 0) {
      doc.fillColor('#888').text('No new users in this period.').fillColor('#000');
    } else {
      // Header row
      const W = [25, 120, 160, 80, 90, 70];
      doc.font('Helvetica-Bold').fontSize(9);
      pdfRow(doc, ['#', 'Name / Username', 'Company', 'Role', 'Platform', 'Joined'], W);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke().moveDown(0.3);
      doc.font('Helvetica').lineWidth(1);

      joined.forEach((u, i) => {
        const bg = i % 2 === 0 ? '#f8f9ff' : '#ffffff';
        const rowY = doc.y;
        doc.rect(50, rowY - 2, 495, 14).fill(bg).fillColor('#000');
        pdfRow(doc, [
          i + 1,
          safePdfName(u),
          u.company_name || '—',
          roleLabel(u.role),
          platformLabel(u.platform),
          fmtDate(u.created_at),
        ], W);
      });
    }
    doc.moveDown(1);

    // Deleted Users table
    pdfSection(doc, `Deleted by Admin (${deleted.length})`);
    if (deleted.length === 0) {
      doc.fillColor('#888').text('No users deleted in this period.').fillColor('#000');
    } else {
      const W2 = [25, 145, 185, 80, 110];
      doc.font('Helvetica-Bold').fontSize(9);
      pdfRow(doc, ['#', 'Name / Username', 'Company', 'Role', 'Deleted On'], W2);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke().moveDown(0.3);
      doc.font('Helvetica').lineWidth(1);

      deleted.forEach((u, i) => {
        const bg = i % 2 === 0 ? '#fff5f5' : '#ffffff';
        const rowY = doc.y;
        doc.rect(50, rowY - 2, 495, 14).fill(bg).fillColor('#000');
        pdfRow(doc, [
          i + 1,
          safePdfName(u),
          u.company_name || '—',
          roleLabel(u.role),
          fmtDate(u.deleted_at),
        ], W2);
      });
    }

    // Footer
    doc.moveDown(2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').lineWidth(0.5).stroke().moveDown(0.3);
    doc.fontSize(8).fillColor('#888')
       .text('Owner Assistant Bot — Confidential Report', { align: 'center' });

    doc.end();
    await new Promise(resolve => stream.on('end', resolve));
    const pdfBuffer = Buffer.concat(chunks);

    const filename = `report_${period}_${audience}_${now.toISOString().slice(0, 10)}.pdf`;
    await ctx.replyWithDocument(
      { source: pdfBuffer, filename },
      {
        caption: `📄 <b>${periodLabel}</b>\nFilter: ${audienceLabel}\n\nJoined: ${joined.length}  |  Deleted: ${deleted.length}  |  Active: ${totalActive}`,
        parse_mode: 'HTML',
      }
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

// ─── Blocks Section ──────────────────────────────────────────────────────────

const haBlocks = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const counts    = await Promise.all(BLOCKS.map(b => User.count({ where: { block: b.key, deleted_at: null } })));
    const unassigned = await User.count({ where: { block: null, deleted_at: null } });

    const buttons = BLOCKS.map((b, i) => [{
      text: `${b.label}  (${counts[i]})`,
      callback_data: `ha_block_view_${b.key}`,
    }]);
    buttons.push([{ text: `❓ Unassigned  (${unassigned})`, callback_data: 'ha_block_view_unassigned' }]);
    buttons.push([{ text: '◀️ Main Menu', callback_data: 'ha_main' }]);

    await ctx.editMessageText(
      `🏷 <b>Blocks</b>\n\nSelect a block:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('haBlocks error:', err);
  }
};

// Tapping a block → two options: Company Owners / Team Members
const haBlockDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const blockKey     = ctx.match[1];
    const isUnassigned = blockKey === 'unassigned';
    const blockInfo    = BLOCKS.find(b => b.key === blockKey);
    const title        = isUnassigned ? '❓ Unassigned' : blockInfo?.label || blockKey;

    const SupportMember = require('../models/SupportMember');
    const [ownerCount, memberCount] = await Promise.all([
      isUnassigned
        ? User.count({ where: { block: null, deleted_at: null } })
        : User.count({ where: { block: blockKey, deleted_at: null } }),
      isUnassigned ? 0 : SupportMember.count({ where: { block: blockKey } }),
    ]);

    const kb = [
      [{ text: `👥 Company Owners  (${ownerCount})`, callback_data: `ha_block_owners_${blockKey}` }],
    ];
    if (!isUnassigned) {
      kb.push([{ text: `👤 Team Members  (${memberCount})`, callback_data: `ha_team_members_${blockKey}` }]);
    }
    kb.push([{ text: '◀️ Blocks', callback_data: 'ha_blocks' }]);

    await ctx.editMessageText(
      `🏷 <b>${title}</b>\n\nSelect a section:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
    );
  } catch (err) {
    logger.error('haBlockDetail error:', err);
  }
};

// Company Owners list for a block
const haBlockOwners = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const blockKey     = ctx.match[1];
    const isUnassigned = blockKey === 'unassigned';
    const blockInfo    = BLOCKS.find(b => b.key === blockKey);
    const title        = isUnassigned ? '❓ Unassigned' : blockInfo?.label || blockKey;

    const where = isUnassigned
      ? { block: null, deleted_at: null }
      : { block: blockKey, deleted_at: null };

    const users = await User.findAll({ where, order: [['created_at', 'DESC']] });

    if (!users.length) {
      return ctx.editMessageText(
        `👥 <b>${title} — Company Owners</b>\n\nNo owners assigned yet.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: `ha_block_view_${blockKey}` }]] } }
      );
    }

    const buttons = users.map(u => [{
      text: `${roleIcon(u.role)} ${userName(u)} — ${u.company_name || 'No company'}${u.blocked ? ' 🚫' : ''}`,
      callback_data: `ha_user_${u.id}`,
    }]);
    buttons.push([{ text: '◀️ Back', callback_data: `ha_block_view_${blockKey}` }]);

    await ctx.editMessageText(
      `👥 <b>${title} — Company Owners</b>  (${users.length})`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('haBlockOwners error:', err);
  }
};

// ─── Team Members (per block) ─────────────────────────────────────────────────

const haTeamMembers = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const blockKey  = ctx.match[1];
    const blockInfo = BLOCKS.find(b => b.key === blockKey);
    const title     = blockInfo?.label || blockKey;

    const SupportMember = require('../models/SupportMember');
    const members = await SupportMember.findAll({ where: { block: blockKey }, order: [['id', 'ASC']] });

    const buttons = members.map(m => [{
      text: `👤 ${m.name}  —  #${m.member_id}`,
      callback_data: `ha_member_remove_confirm_${m.id}`,
    }]);
    buttons.push([{ text: '➕ Add Member', callback_data: `ha_member_add_${blockKey}` }]);
    buttons.push([{ text: '◀️ Back', callback_data: `ha_block_view_${blockKey}` }]);

    await ctx.editMessageText(
      `👤 <b>${title} — Team Members</b>  (${members.length})\n\n` +
      (members.length ? `Tap a member to remove them.` : `No members yet. Tap <b>➕ Add Member</b> to add one.`),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('haTeamMembers error:', err);
  }
};

const haTeamMemberAdd = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const blockKey = ctx.match[1];
    adminSessions.set(ctx.from.id, { action: 'member_add_name', block: blockKey });
    await ctx.editMessageText(
      `➕ <b>Add Team Member</b>\n\nStep 1 of 2\n\nEnter the member's <b>nickname</b>:\n<i>(e.g. LEADER MO)</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `ha_team_members_${blockKey}` }]] } }
    );
  } catch (err) {
    logger.error('haTeamMemberAdd error:', err);
  }
};

const haTeamMemberRemoveConfirm = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const SupportMember = require('../models/SupportMember');
    const id = parseInt(ctx.match[1], 10);
    const m  = await SupportMember.findByPk(id);
    if (!m) return ctx.editMessageText('❌ Member not found.', { reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'ha_blocks' }]] } });

    await ctx.editMessageText(
      `🗑 <b>Remove Member</b>\n\nAre you sure you want to remove:\n\n👤 <b>${m.name}</b>  —  #${m.member_id}\n\nThey will no longer appear on claim buttons.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Yes, Remove', callback_data: `ha_member_remove_${id}` }],
            [{ text: '❌ Cancel',      callback_data: `ha_team_members_${m.block}` }],
          ],
        },
      }
    );
  } catch (err) {
    logger.error('haTeamMemberRemoveConfirm error:', err);
  }
};

const haTeamMemberRemove = async (ctx) => {
  try {
    await ctx.answerCbQuery('Member removed.');
    const SupportMember = require('../models/SupportMember');
    const id = parseInt(ctx.match[1], 10);
    const m  = await SupportMember.findByPk(id);
    if (!m) {
      return ctx.editMessageText('❌ Member not found or already removed.', {
        reply_markup: { inline_keyboard: [[{ text: '◀️ Blocks', callback_data: 'ha_blocks' }]] },
      });
    }
    const blockKey = m.block;
    await SupportMember.destroy({ where: { id } });
    ctx.match = ['', blockKey];
    await haTeamMembers(ctx);
  } catch (err) {
    logger.error('haTeamMemberRemove error:', err);
  }
};

// ─── Assign Block ────────────────────────────────────────────────────────────

const haAssignBlock = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = parseInt(ctx.match[1], 10);
    const u = await User.findByPk(userId);
    if (!u) return ctx.editMessageText('❌ User not found.', { reply_markup: BACK_KB });

    const rows = [];
    for (let i = 0; i < BLOCKS.length; i += 3) {
      rows.push(BLOCKS.slice(i, i + 3).map(b => ({
        text: u.block === b.key ? `✅ ${b.label}` : b.label,
        callback_data: `ha_setblock_${userId}_${b.key}`,
      })));
    }
    rows.push([{ text: '◀️ Back', callback_data: `ha_user_${userId}` }]);

    await ctx.editMessageText(
      `🏷 <b>Assign Block</b>\n\n` +
      `👤 ${userName(u)}\n` +
      `🏢 ${u.company_name || '—'}\n` +
      `Current: <b>${blockLabel(u.block)}</b>\n\n` +
      `Select a block:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    logger.error('haAssignBlock error:', err);
  }
};

const haSetBlock = async (ctx) => {
  try {
    const userId = parseInt(ctx.match[1], 10);
    const blockKey = ctx.match[2];
    const found = BLOCKS.find(b => b.key === blockKey);
    await ctx.answerCbQuery(found ? `Block set: ${found.label}` : 'Block updated');
    await User.update({ block: blockKey }, { where: { id: userId } });
    ctx.match[1] = String(userId);
    await haUserDetail(ctx);
  } catch (err) {
    logger.error('haSetBlock error:', err);
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
  haUsersMenu, haUsers, haUserDetail, haSetRole, haBlock, haUnblock, haDeleteConfirm, haDeleteUser,
  haOrders, haOrderDetail,
  haBroadcast, haBcTarget,
  haReport, haReportAudience, haGenerateReport,
  haAdmins, haAdminDetail, haAdminAdd, haAdminChooseType, haAdminSetRole, haAdminRemove,
  haBlocks, haBlockDetail, haBlockOwners,
  haAssignBlock, haSetBlock,
  haTeamMembers, haTeamMemberAdd, haTeamMemberRemoveConfirm, haTeamMemberRemove,
  haHandleText,
  notifyNewOrder,
  ADMIN_ROLES,
};
