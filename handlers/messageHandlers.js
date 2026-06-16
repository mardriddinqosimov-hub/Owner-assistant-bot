const logger = require('../utils/logger');
const User = require('../models/User');
const Order = require('../models/Order');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const notifService = require('../services/notificationService');
const { notifyHeadAdmin } = notifService;
const {
  orderSessions,
  ORDER_STEPS,
  ORDER_PROMPTS,
  CANCEL_KB,
  registrationSessions,
  REG_STEPS,
  REG_PROMPTS,
  cardSessions,
  showConfirmation,
  buildOrderSummary,
  specialTaskSessions,
} = require('./callbackHandlers');

const ORDER_GROUP_ID = process.env.ORDER_GROUP_ID || '-5129310180';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function completeOrder(ctx, session, fileId, type) {
  const user = await User.findOne({ where: { telegram_id: ctx.from.id } });

  const qty = session.type === 'fullset' ? (session.sets || 0) : (session.items?.pt30 || 0);

  let itemsJson = null;
  if (session.type === 'fullset') {
    itemsJson = JSON.stringify({ type: 'fullset', cable_type: session.cable_type, sets: session.sets });
  } else if (session.type === 'custom') {
    itemsJson = JSON.stringify({ type: 'custom', ...session.items });
  }

  let order = null;
  if (user) {
    order = await Order.create({
      user_id:         user.id,
      owner_name:      session.owner_name,
      company_name:    session.company_name,
      email:           session.email,
      phone:           session.phone,
      location:        session.location,
      qty,
      shipping:        session.shipping,
      total:           session.total,
      order_type:      session.type || null,
      items:           itemsJson,
      status:          'active',
      payment_file_id: fileId,
      created_at:      new Date(),
      updated_at:      new Date(),
    });
  }

  const title = order ? `🎉 <b>New Order #${order.id}!</b>` : '🎉 <b>New Order!</b>';
  const adminCaption =
    buildOrderSummary(session, title) +
    `\n\n👤 Telegram ID: ${ctx.from.id}` +
    (order ? `\n\n<b>/track ${order.id} TRACKING_URL</b>` : '');

  // Forward to order group
  try {
    if (type === 'photo') {
      await ctx.telegram.sendPhoto(ORDER_GROUP_ID, fileId, { caption: adminCaption, parse_mode: 'HTML' });
    } else {
      await ctx.telegram.sendDocument(ORDER_GROUP_ID, fileId, { caption: adminCaption, parse_mode: 'HTML' });
    }
  } catch (err) {
    logger.warn('Failed to forward to order group:', err.message);
  }

  // Notify accounting bot + head admin
  await notifService.notifyAdminNewOrder(fileId, type, adminCaption);
  if (order) await notifyHeadAdmin(order);

  await ctx.reply(
    `✅ <b>Order Completed!</b>${order ? ` (Order #${order.id})` : ''}\n\n` +
    `Your payment has been received and order placed.\n\n` +
    `We'll contact you at:\n` +
    `📧 ${session.email}\n` +
    `📱 ${session.phone}\n\n` +
    `Track your order in <b>Order Devices → Active Orders</b>.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Main Menu', callback_data: 'main_menu' }],
        ],
      },
    }
  );
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const handleText = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (ctx.message.text.startsWith('/')) return;

  const userId = ctx.from.id;

  // ── Registration flow ──────────────────────────────────────────────────────
  const regSession = registrationSessions.get(userId);
  if (regSession && REG_STEPS.includes(regSession.step)) {
    const answer = ctx.message.text.trim();
    regSession[regSession.step] = answer;
    const idx = REG_STEPS.indexOf(regSession.step);

    if (idx < REG_STEPS.length - 1) {
      regSession.step = REG_STEPS[idx + 1];
      return ctx.reply(REG_PROMPTS[regSession.step], { parse_mode: 'HTML' });
    }

    // All 4 answers collected — save to DB
    const user = await User.findOne({ where: { telegram_id: userId } });
    if (user) {
      await user.update({
        owner_name:       regSession.reg_owner_name,
        contact_email:    regSession.reg_email,
        phone:            regSession.reg_phone,
        delivery_address: regSession.reg_address,
      });
    }
    registrationSessions.delete(userId);

    if (regSession.returnTo === 'resume_order') {
      // Profile updated — re-populate the active order session and show confirmation
      const orderSession = orderSessions.get(userId);
      if (orderSession) {
        orderSession.owner_name = regSession.reg_owner_name;
        orderSession.email      = regSession.reg_email;
        orderSession.phone      = regSession.reg_phone;
        orderSession.location   = regSession.reg_address;
        orderSession.step       = 'confirmation';
        return showConfirmation(ctx, orderSession);
      }
    }

    // returnTo: 'order_submenu' — profile setup done, go to ordering
    return ctx.reply(
      `✅ <b>Profile saved!</b>\n\nYou're all set. Your details will be pre-filled on every future order.\n\nTap below to start ordering:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📦 Order Devices', callback_data: 'order_devices_start' }],
            [{ text: '🏠 Main Menu',     callback_data: 'main_menu' }],
          ],
        },
      }
    );
  }

  // ── Card collection flow ───────────────────────────────────────────────────
  if (cardSessions.has(userId)) {
    const session  = cardSessions.get(userId);
    const cardInfo = ctx.message.text.trim();
    cardSessions.delete(userId);
    const user = await User.findOne({ where: { telegram_id: userId } });
    if (user) await user.update({ card_info: cardInfo });
    const last4   = cardInfo.replace(/\s/g, '').slice(-4);
    const purpose = session?.purpose || 'save';

    if (purpose === 'withdraw' && user) {
      const balance = parseFloat(user.referral_balance || 0);
      if (balance > 0) {
        await WithdrawalRequest.create({
          owner_id:  user.id,
          amount:    balance,
          card_info: cardInfo,
          status:    'pending',
          source:    'balance',
        });
      }
      const acctBot = notifService.getAccountingBot();
      const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';
      if (acctBot && balance > 0) {
        try {
          const ownerLabel = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.owner_name || `ID ${user.telegram_id}`;
          await acctBot.telegram.sendMessage(
            ADMIN_ID,
            `💳 <b>Balance Withdrawal Request</b>\n\nOwner: <b>${ownerLabel}</b>\nCompany: ${user.company_name || '—'}\nAmount: <b>$${balance.toFixed(2)}</b>\nCard: ••••${last4} (just saved)`,
            { parse_mode: 'HTML' }
          );
        } catch {}
      }
      return ctx.reply(
        `✅ <b>Card saved & Withdrawal Requested!</b>\n\nYour card ending in <b>${last4}</b> has been saved.\n\n<b>$${balance.toFixed(2)}</b> will be sent to your card within 1–2 business days.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] } }
      );
    }

    return ctx.reply(
      `✅ <b>Card saved!</b>\n\nYour card ending in <b>${last4}</b> has been saved.\n\nThe accounting team will send your referral reward there.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] } }
    );
  }

  const session = orderSessions.get(userId);

  if (session && ORDER_STEPS.includes(session.step)) {
    const answer = ctx.message.text.trim();
    if (!answer) return ctx.reply('Please enter a valid answer.');

    session[session.step] = answer;
    const idx = ORDER_STEPS.indexOf(session.step);

    if (idx < ORDER_STEPS.length - 1) {
      session.step = ORDER_STEPS[idx + 1];
      await ctx.reply(ORDER_PROMPTS[session.step], { parse_mode: 'HTML', reply_markup: CANCEL_KB });
    } else {
      session.step = 'confirmation';
      await showConfirmation(ctx, session);
    }
    return;
  }

  if (session && session.step === 'payment') {
    return ctx.reply('📎 Please send a <b>photo or PDF</b> of your payment screenshot.', { parse_mode: 'HTML' });
  }

  // ── Special Task: owner typing their message request ──────────────────────
  if (specialTaskSessions.get(userId) === 'awaiting_text') {
    specialTaskSessions.delete(userId);
    const requestText = ctx.message.text.trim();

    const user = await User.findOne({ where: { telegram_id: userId } });
    if (!user) return ctx.reply('Please /start first.');

    const SupportTask = require('../models/SupportTask');
    const { getSupportBot } = require('../services/notificationService');
    const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-5568165011';
    const supportBot = getSupportBot();

    const ownerLabel = user.owner_name || user.company_name || ctx.from.first_name || 'Owner';

    const task = await SupportTask.create({
      owner_user_id:     user.id,
      owner_telegram_id: String(userId),
      owner_name:        ownerLabel,
      type:              'message',
      request_text:      requestText,
      status:            'pending',
      created_at:        new Date(),
      updated_at:        new Date(),
    });

    if (supportBot) {
      try {
        const sent = await supportBot.telegram.sendMessage(
          SUPPORT_CHAT_ID,
          `🔔 <b>New Request</b>\n\n` +
          `👤 Owner: <b>${ownerLabel}</b>\n` +
          `🏢 Company: ${user.company_name || '—'}\n\n` +
          `📝 Request:\n${requestText}\n\n` +
          `<i>Reply to this message with: <code>done [yourMemberID]</code></i>`,
          { parse_mode: 'HTML', message_thread_id: parseInt(process.env.TOPIC_NEW_REQUEST || '2') }
        );
        await task.update({ support_message_id: sent.message_id });
      } catch (err) {
        const newId = err.response?.parameters?.migrate_to_chat_id;
        if (newId) {
          logger.error(`SUPPORT_SEND_FAIL: group migrated to supergroup. NEW_CHAT_ID=${newId}`);
        } else {
          logger.error(`SUPPORT_SEND_FAIL chat=${SUPPORT_CHAT_ID} thread=${process.env.TOPIC_NEW_REQUEST || '2'} err=${err.message}`);
        }
      }
    } else {
      logger.error('SUPPORT_SEND_FAIL: supportBot is null');
    }

    return ctx.reply(
      `✅ <b>Request sent to support!</b>\n\nThe team will handle it shortly. You'll be notified here when it's done.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] } }
    );
  }

  await ctx.reply('Use /help to see available commands.');
};

const handlePhoto = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const userId = ctx.from.id;
  const session = orderSessions.get(userId);
  if (!session || session.step !== 'payment') return;

  try {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    await completeOrder(ctx, session, fileId, 'photo');
    orderSessions.delete(userId);
  } catch (err) {
    logger.error('handlePhoto error:', err);
    await ctx.reply('❌ Error processing payment. Please try again.');
  }
};

const handleDocument = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const userId = ctx.from.id;
  const session = orderSessions.get(userId);
  if (!session || session.step !== 'payment') {
    logger.debug(`Document from ${userId} (no active payment session)`);
    return ctx.reply('Use /help to see available commands.');
  }

  try {
    const fileId = ctx.message.document.file_id;
    await completeOrder(ctx, session, fileId, 'document');
    orderSessions.delete(userId);
  } catch (err) {
    logger.error('handleDocument error:', err);
    await ctx.reply('❌ Error processing payment. Please try again.');
  }
};

module.exports = { handleText, handlePhoto, handleDocument };
