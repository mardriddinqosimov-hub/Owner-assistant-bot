const { Op } = require('sequelize');
const User     = require('../models/User');
const Referral = require('../models/Referral');
const logger   = require('../utils/logger');
const { getAccountingBot, getMainBot } = require('../services/notificationService');

const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';

// ─── In-memory intake sessions (for referred clients) ─────────────────────────
const mgmtSessions = new Map();
const INTAKE_STEPS = ['name', 'company', 'trucks', 'phone'];
const INTAKE_PROMPTS = {
  name:    '👤 <b>(1/4) Your Full Name</b>\n\nPlease enter your full name:',
  company: '🏢 <b>(2/4) Company Name</b>\n\nWhat is your company name?',
  trucks:  '🚛 <b>(3/4) Number of Trucks</b>\n\nHow many trucks does your company have?',
  phone:   '📱 <b>(4/4) Phone Number</b>\n\nPlease enter your phone number:',
};

function userName(u) {
  const n = [u.first_name, u.last_name].filter(Boolean).join(' ');
  return n || u.username || u.owner_name || `ID ${u.telegram_id}`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function statusLabel(s) {
  return { pending: '⏳ Pending', confirmed: '✅ Confirmed', rejected: '❌ Rejected', paid: '💰 Paid' }[s] || s;
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

async function showAdminPanel(ctx) {
  const [pending, confirmed] = await Promise.all([
    Referral.count({ where: { status: 'pending' } }),
    Referral.count({ where: { status: 'confirmed' } }),
  ]);
  const text =
    `🔐 <b>OA Management</b>\n\n` +
    `⏳ Pending referrals: <b>${pending}</b>\n` +
    `✅ Confirmed (awaiting payout): <b>${confirmed}</b>`;
  const kb = {
    inline_keyboard: [
      [{ text: `⏳ Pending Referrals${pending ? ` (${pending})` : ''}`, callback_data: 'mg_pending' }],
      [{ text: '📋 All Referrals', callback_data: 'mg_all_0' }],
      [{ text: '💰 Owner Balances',  callback_data: 'mg_balances' }],
    ],
  };
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────

const mgmtStart = async (ctx) => {
  try {
    const isAdmin = String(ctx.from.id) === String(ADMIN_ID);
    const param   = ctx.startPayload; // 'ref_123' or empty

    if (isAdmin && !param) {
      const [pending, confirmed] = await Promise.all([
        Referral.count({ where: { status: 'pending' } }),
        Referral.count({ where: { status: 'confirmed' } }),
      ]);
      return ctx.reply(
        `🔐 <b>OA Management</b>\n\n⏳ Pending: <b>${pending}</b>  |  ✅ Confirmed: <b>${confirmed}</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: `⏳ Pending${pending ? ` (${pending})` : ''}`, callback_data: 'mg_pending' }],
              [{ text: '📋 All Referrals', callback_data: 'mg_all_0' }],
              [{ text: '💰 Owner Balances',  callback_data: 'mg_balances' }],
            ],
          },
        }
      );
    }

    if (param?.startsWith('ref_')) {
      const ownerId = parseInt(param.slice(4), 10);
      const owner = await User.findByPk(ownerId);
      if (!owner || !owner.company_name) {
        return ctx.reply('⚠️ This referral link is invalid. Please ask your contact for a new link.');
      }

      mgmtSessions.set(ctx.from.id, { step: 'name', owner_id: ownerId });
      return ctx.reply(
        `👋 <b>Welcome to Algo Group!</b>\n\n` +
        `You've been referred by <b>${userName(owner)}</b> — ${owner.company_name}.\n\n` +
        `We provide ELD solutions for trucking companies. Let me get a few details from you:\n\n` +
        INTAKE_PROMPTS.name,
        { parse_mode: 'HTML' }
      );
    }

    ctx.reply(
      '👋 Welcome to Algo Group.\n\nPlease contact us via a referral link, or reach out to your account manager.',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error('mgmtStart error:', err);
  }
};

// ─── Client text intake ───────────────────────────────────────────────────────

const mgmtHandleText = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (ctx.message.text?.startsWith('/')) return;

  const userId  = ctx.from.id;
  const isAdmin = String(userId) === String(ADMIN_ID);

  if (isAdmin) return; // admin text handled separately (notes etc.)

  const session = mgmtSessions.get(userId);
  if (!session || !INTAKE_STEPS.includes(session.step)) return;

  session[session.step] = ctx.message.text.trim();
  const idx = INTAKE_STEPS.indexOf(session.step);

  if (idx < INTAKE_STEPS.length - 1) {
    session.step = INTAKE_STEPS[idx + 1];
    return ctx.reply(INTAKE_PROMPTS[session.step], { parse_mode: 'HTML' });
  }

  // All info collected — create referral record
  mgmtSessions.delete(userId);

  const ref = await Referral.create({
    owner_id:             session.owner_id,
    referred_telegram_id: userId,
    referred_name:        session.name,
    referred_company:     session.company,
    trucks_count:         parseInt(session.trucks) || null,
    referred_phone:       session.phone,
    status:               'pending',
    reward:               200.00,
  });

  await ctx.reply(
    `✅ <b>Thank you, ${session.name}!</b>\n\n` +
    `Your information has been received. Our team will contact you at <b>${session.phone}</b> shortly.\n\n` +
    `We look forward to working with <b>${session.company}</b>!`,
    { parse_mode: 'HTML' }
  );

  // Look up owner name + company for the notification
  const owner = await User.findByPk(session.owner_id);
  const ownerTgName  = owner ? ([owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.username || owner.owner_name || `ID ${owner.telegram_id}`) : `ID ${session.owner_id}`;
  const ownerCompany = owner?.company_name || '—';

  // Notify admin in this bot
  const { getManagementBot } = require('../services/notificationService');
  const mgmtBot = getManagementBot();
  if (mgmtBot) {
    try {
      await mgmtBot.telegram.sendMessage(
        ADMIN_ID,
        `🔔 <b>New Referral — Action Required</b>\n\n` +
        `<b>New Client:</b>\n` +
        `👤 ${session.name}\n` +
        `🏢 ${session.company}\n` +
        `🚛 Trucks: ${session.trucks}\n` +
        `📱 ${session.phone}\n\n` +
        `<b>Referred by:</b>\n` +
        `👨‍💼 ${ownerTgName} — ${ownerCompany}\n\n` +
        `Confirm the <b>$200</b> referral reward for this owner?`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Confirm Reward (+$200)', callback_data: `mg_confirm_${ref.id}` },
                { text: '❌ Reject',                 callback_data: `mg_reject_${ref.id}` },
              ],
            ],
          },
        }
      );
    } catch (e) {
      logger.warn('Failed to notify admin of new referral:', e.message);
    }
  }
};

// ─── Admin: pending referrals ─────────────────────────────────────────────────

const mgmtPending = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const refs = await Referral.findAll({ where: { status: 'pending' }, order: [['created_at', 'DESC']] });

    if (!refs.length) {
      return ctx.editMessageText('⏳ No pending referrals.', {
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'mg_main' }]] },
      });
    }

    const buttons = refs.map(r => [{
      text: `#${r.id} ${r.referred_name || '?'} — ${r.referred_company || '?'} | ${fmtDate(r.created_at)}`,
      callback_data: `mg_ref_${r.id}`,
    }]);
    buttons.push([{ text: '◀️ Back', callback_data: 'mg_main' }]);

    await ctx.editMessageText(
      `⏳ <b>Pending Referrals (${refs.length})</b>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('mgmtPending error:', err);
  }
};

const mgmtAllReferrals = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1] || 0, 10);
    const PAGE = 8;
    const all  = await Referral.findAll({ order: [['created_at', 'DESC']] });
    const slice = all.slice(page * PAGE, (page + 1) * PAGE);
    const pages = Math.ceil(all.length / PAGE) || 1;

    const buttons = slice.map(r => [{
      text: `${statusLabel(r.status)} #${r.id} ${r.referred_name || '?'} — ${r.referred_company || '?'}`,
      callback_data: `mg_ref_${r.id}`,
    }]);

    const nav = [];
    if (page > 0)         nav.push({ text: '◀️ Prev', callback_data: `mg_all_${page - 1}` });
    if (page < pages - 1) nav.push({ text: 'Next ▶️', callback_data: `mg_all_${page + 1}` });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: '◀️ Back', callback_data: 'mg_main' }]);

    await ctx.editMessageText(
      `📋 <b>All Referrals</b> (${all.length} total, page ${page + 1}/${pages})`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (err) {
    logger.error('mgmtAllReferrals error:', err);
  }
};

const mgmtRefDetail = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const refId = parseInt(ctx.match[1], 10);
    const ref   = await Referral.findByPk(refId);
    if (!ref) return ctx.editMessageText('❌ Referral not found.');

    const owner = await User.findByPk(ref.owner_id);
    const text =
      `📋 <b>Referral #${ref.id}</b>\n\n` +
      `👤 Client: <b>${ref.referred_name || '—'}</b>\n` +
      `🏢 Company: ${ref.referred_company || '—'}\n` +
      `🚛 Trucks: ${ref.trucks_count || '—'}\n` +
      `📱 Phone: ${ref.referred_phone || '—'}\n\n` +
      `🔗 Referred by: <b>${owner ? userName(owner) : `ID ${ref.owner_id}`}</b>\n` +
      `💰 Reward: $${parseFloat(ref.reward).toFixed(2)}\n` +
      `📅 Submitted: ${fmtDate(ref.created_at)}\n` +
      `Status: ${statusLabel(ref.status)}`;

    const rows = [];
    if (ref.status === 'pending') {
      rows.push([
        { text: '✅ Confirm (+$200)', callback_data: `mg_confirm_${refId}` },
        { text: '❌ Reject',          callback_data: `mg_reject_${refId}` },
      ]);
    }
    rows.push([{ text: '◀️ Back', callback_data: 'mg_pending' }]);

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  } catch (err) {
    logger.error('mgmtRefDetail error:', err);
  }
};

const mgmtConfirm = async (ctx) => {
  try {
    await ctx.answerCbQuery('Confirmed!');
    const refId = parseInt(ctx.match[1], 10);
    const ref   = await Referral.findByPk(refId);
    if (!ref || ref.status !== 'pending') return ctx.answerCbQuery('Already processed.');

    await ref.update({ status: 'confirmed', confirmed_at: new Date() });

    const owner = await User.findByPk(ref.owner_id);
    if (owner) {
      const newBal = parseFloat(owner.referral_balance || 0) + parseFloat(ref.reward);
      await owner.update({ referral_balance: newBal.toFixed(2) });

      // Notify owner via main bot
      const mainBot = getMainBot();
      if (mainBot) {
        try {
          await mainBot.telegram.sendMessage(
            owner.telegram_id,
            `🎉 <b>Referral Confirmed!</b>\n\n` +
            `Your referral of <b>${ref.referred_company || ref.referred_name}</b> has been approved!\n\n` +
            `💰 <b>+$${parseFloat(ref.reward).toFixed(2)}</b> added to your referral balance.\n` +
            `💵 Your total balance: <b>$${newBal.toFixed(2)}</b>\n\n` +
            `The accounting team will process your payout shortly.`,
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          logger.warn('Failed to notify owner of referral confirm:', e.message);
        }

        // Ask for card info if owner hasn't provided it yet
        if (!owner.card_info) {
          try {
            const { cardSessions } = require('./callbackHandlers');
            cardSessions.set(Number(owner.telegram_id), { purpose: 'save' });
            await mainBot.telegram.sendMessage(
              owner.telegram_id,
              `💳 <b>One more thing — add your card for payouts</b>\n\n` +
              `To receive your <b>$${parseFloat(ref.reward).toFixed(2)}</b> reward, please send your card number:\n\n` +
              `<i>Example: 4111 1111 1111 1234</i>`,
              { parse_mode: 'HTML' }
            );
          } catch (e) {
            logger.warn('Failed to ask owner for card info:', e.message);
          }
        }
      }

      // Notify accounting bot
      const acctBot = getAccountingBot();
      if (acctBot) {
        try {
          await acctBot.telegram.sendMessage(
            ADMIN_ID,
            `💰 <b>Referral Payout Ready</b>\n\n` +
            `Owner: <b>${userName(owner)}</b>\n` +
            `Company: ${owner.company_name || '—'}\n` +
            `Referral #${ref.id} — ${ref.referred_company || ref.referred_name}\n` +
            `Amount: <b>$${parseFloat(ref.reward).toFixed(2)}</b>\n` +
            `Owner Balance: <b>$${newBal.toFixed(2)}</b>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '💳 Pay to Card',      callback_data: `acct_ref_card_${ref.id}` },
                    { text: '📦 Apply to Orders',  callback_data: `acct_ref_credit_${ref.id}` },
                  ],
                ],
              },
            }
          );
        } catch (e) {
          logger.warn('Failed to notify accounting of referral payout:', e.message);
        }
      }
    }

    await ctx.editMessageText(
      `✅ <b>Referral #${refId} Confirmed</b>\n\n$${parseFloat(ref.reward).toFixed(2)} added to owner's balance.\nAccounting team has been notified.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'mg_pending' }]] } }
    );
  } catch (err) {
    logger.error('mgmtConfirm error:', err);
  }
};

const mgmtReject = async (ctx) => {
  try {
    await ctx.answerCbQuery('Rejected.');
    const refId = parseInt(ctx.match[1], 10);
    const ref   = await Referral.findByPk(refId);
    if (!ref) return;

    await ref.update({ status: 'rejected' });

    // Notify owner
    const owner = await User.findByPk(ref.owner_id);
    const mainBot = getMainBot();
    if (owner && mainBot) {
      try {
        await mainBot.telegram.sendMessage(
          owner.telegram_id,
          `ℹ️ <b>Referral Update</b>\n\nYour referral of <b>${ref.referred_company || ref.referred_name}</b> was not approved this time.\n\nContact us if you have questions.`,
          { parse_mode: 'HTML' }
        );
      } catch {}
    }

    await ctx.editMessageText(
      `❌ <b>Referral #${refId} Rejected</b>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'mg_pending' }]] } }
    );
  } catch (err) {
    logger.error('mgmtReject error:', err);
  }
};

const mgmtBalances = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const owners = await User.findAll({
      where: { referral_balance: { [Op.gt]: 0 }, deleted_at: null },
      order: [['referral_balance', 'DESC']],
    });

    if (!owners.length) {
      return ctx.editMessageText('💰 No owners with referral balance.', {
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'mg_main' }]] },
      });
    }

    const lines = owners.map((u, i) =>
      `${i + 1}. ${userName(u)} — <b>$${parseFloat(u.referral_balance).toFixed(2)}</b>`
    ).join('\n');

    await ctx.editMessageText(
      `💰 <b>Owner Referral Balances</b>\n\n${lines}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'mg_main' }]] } }
    );
  } catch (err) {
    logger.error('mgmtBalances error:', err);
  }
};

const mgmtMain = async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await showAdminPanel(ctx);
  } catch (err) {
    logger.error('mgmtMain error:', err);
  }
};

module.exports = {
  mgmtStart, mgmtHandleText,
  mgmtPending, mgmtAllReferrals, mgmtRefDetail,
  mgmtConfirm, mgmtReject,
  mgmtBalances, mgmtMain,
};
