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
        const existingPending = await WithdrawalRequest.findOne({ where: { owner_id: user.id, status: 'pending' } });
        if (!existingPending) {
          await WithdrawalRequest.create({
            owner_id:  user.id,
            amount:    balance,
            card_info: cardInfo,
            status:    'pending',
            source:    'balance',
          });
        }
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

    if (!requestText) {
      specialTaskSessions.set(userId, 'awaiting_text');
      return ctx.reply('⚠️ Please enter a non-empty message. Try again:');
    }

    const user = await User.findOne({ where: { telegram_id: userId } });
    if (!user) return ctx.reply('Please /start first.');

    const SupportTask = require('../models/SupportTask');
    const { getSupportBot } = require('../services/notificationService');
    const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-1004396785239';
    const supportBot = getSupportBot();
    const { Op } = require('sequelize');

    // Only relay if support is actively working — in_process or awaiting_approval
    const claimedTask = await SupportTask.findOne({
      where: { owner_telegram_id: String(userId), status: { [Op.in]: ['in_process', 'awaiting_approval'] } },
      order: [['created_at', 'DESC']],
    });
    if (claimedTask) {
      let relayed = false;
      if (supportBot) {
        let existingTopicId = claimedTask.topic_id;
        if (!existingTopicId) {
          const priorWithTopic = await SupportTask.findOne({
            where: { owner_telegram_id: String(userId), topic_id: { [Op.not]: null } },
            order: [['created_at', 'DESC']],
          });
          if (priorWithTopic) {
            existingTopicId = priorWithTopic.topic_id;
            await claimedTask.update({ topic_id: existingTopicId });
          }
        }
        if (existingTopicId) {
          const senderName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Owner';
          try {
            await supportBot.telegram.sendMessage(
              SUPPORT_CHAT_ID,
              `👤 <b>${senderName}:</b>\n${requestText}`,
              { parse_mode: 'HTML', message_thread_id: existingTopicId }
            );
            relayed = true;
            if (claimedTask.claimed_telegram_id) {
              await supportBot.telegram.sendMessage(
                SUPPORT_CHAT_ID,
                `🔔 <a href="tg://user?id=${claimedTask.claimed_telegram_id}">${claimedTask.claimed_by || 'Support'}</a> — owner replied above`,
                { parse_mode: 'HTML', message_thread_id: existingTopicId }
              ).catch(() => {});
            }
          } catch (err) {
            logger.warn('Owner→topic relay (specialTask) failed — treating task as stale:', err.message);
          }
        }
      }
      if (relayed) {
        return ctx.reply(
          `✅ <b>Message sent to support!</b>\n\nThe team will see it in your open request.`,
          { parse_mode: 'HTML' }
        );
      }
      // Relay failed — task is stale; cancel it and fall through to create a fresh one
      await claimedTask.update({ status: 'cancelled', updated_at: new Date() });
    }

    // Cancel any remaining stale unclaimed tasks — owner wants a fresh start
    await SupportTask.update(
      { status: 'cancelled', updated_at: new Date() },
      { where: { owner_telegram_id: String(userId), status: 'pending' } }
    );

    const ownerLabel = user.owner_name || user.company_name || ctx.from.first_name || 'Owner';

    // Find this owner's permanent topic (any past task that has a topic_id)
    const priorTask = await SupportTask.findOne({
      where: { owner_telegram_id: String(userId), topic_id: { [Op.not]: null } },
      order: [['created_at', 'DESC']],
    });
    let topicId = priorTask?.topic_id || null;

    const task = await SupportTask.create({
      owner_user_id:     user.id,
      owner_telegram_id: String(userId),
      owner_name:        ownerLabel,
      type:              'message',
      request_text:      requestText,
      status:            'pending',
      topic_id:          topicId,
      created_at:        new Date(),
      updated_at:        new Date(),
    });

    if (supportBot) {
      try {
        if (!topicId) {
          // First-ever request from this owner — create their permanent topic
          const topic = await supportBot.telegram.createForumTopic(SUPPORT_CHAT_ID, `👤 ${ownerLabel}`);
          topicId = topic.message_thread_id;
          await task.update({ topic_id: topicId });
        }

        const requestMsgText =
          `🔔 <b>New Request</b>\n\n` +
          `👤 Owner: <b>${ownerLabel}</b>\n` +
          `🏢 Company: ${user.company_name || '—'}\n\n` +
          `📝 Request:\n${requestText}`;
        const requestMsgOpts = {
          parse_mode: 'HTML',
          message_thread_id: topicId,
          reply_markup: { inline_keyboard: [[{ text: '✅ Claim Case', callback_data: `sup_claim_${task.id}` }]] },
        };

        // Post the new request into the owner's topic — if it fails, create a fresh topic and retry once
        try {
          await supportBot.telegram.sendMessage(SUPPORT_CHAT_ID, requestMsgText, requestMsgOpts);
        } catch (topicErr) {
          logger.warn(`Topic ${topicId} is dead (${topicErr.message}) — creating a new one`);
          const newTopic = await supportBot.telegram.createForumTopic(SUPPORT_CHAT_ID, `👤 ${ownerLabel}`);
          topicId = newTopic.message_thread_id;
          await task.update({ topic_id: topicId });
          requestMsgOpts.message_thread_id = topicId;
          await supportBot.telegram.sendMessage(SUPPORT_CHAT_ID, requestMsgText, requestMsgOpts);
        }

        // Escalation reminders: 30s, 2min, 5min
        setTimeout(async () => {
          try {
            const fresh = await SupportTask.findByPk(task.id);
            if (fresh && fresh.status === 'pending') {
              await supportBot.telegram.sendMessage(
                SUPPORT_CHAT_ID,
                `⚠️ <b>Unclaimed for 30 seconds</b> — please claim this request!`,
                { parse_mode: 'HTML', message_thread_id: topicId }
              );
            }
          } catch {}
        }, 30 * 1000);

        setTimeout(async () => {
          try {
            const fresh = await SupportTask.findByPk(task.id);
            if (fresh && fresh.status === 'pending') {
              await supportBot.telegram.sendMessage(
                SUPPORT_CHAT_ID,
                `🚨 <b>Still unclaimed — 2 minutes passed!</b> Please claim this request.`,
                { parse_mode: 'HTML', message_thread_id: topicId }
              );
            }
          } catch {}
        }, 2 * 60 * 1000);

        setTimeout(async () => {
          try {
            const fresh = await SupportTask.findByPk(task.id);
            if (fresh && fresh.status === 'pending') {
              await supportBot.telegram.sendMessage(
                SUPPORT_CHAT_ID,
                `🔴 <b>URGENT — 5 minutes unclaimed!</b> Owner is waiting. Handle this immediately.`,
                { parse_mode: 'HTML', message_thread_id: topicId }
              );
            }
          } catch {}
        }, 5 * 60 * 1000);

      } catch (err) {
        logger.error(`Support topic post failed (task ${task.id}): ${err.message}`);
        try {
          await supportBot.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `⚠️ <b>New Request</b> (topic post failed)\n\n` +
            `👤 Owner: <b>${ownerLabel}</b>\n` +
            `🏢 Company: ${user.company_name || '—'}\n\n` +
            `📝 Request:\n${requestText}\n\n` +
            `Task ID: <code>${task.id}</code>`,
            { parse_mode: 'HTML' }
          );
        } catch (fallbackErr) {
          logger.error('Support fallback send also failed:', fallbackErr.message);
        }
      }
    } else {
      logger.error('SUPPORT_SEND_FAIL: supportBot is null');
    }

    return ctx.reply(
      `✅ <b>Request sent to support!</b>\n\nThe team will handle it shortly. Feel free to send more details here — they'll appear in your support thread.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] } }
    );
  }

  // ── Active support session: relay owner messages to the support topic ──────
  {
    const SupportTask = require('../models/SupportTask');
    const { Op } = require('sequelize');
    const { getSupportBot } = require('../services/notificationService');
    const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-1004396785239';
    const activeTask = await SupportTask.findOne({
      where: { owner_telegram_id: String(userId), status: { [Op.in]: ['pending', 'in_process', 'awaiting_approval'] } },
    });
    if (activeTask) {
      const supBot = getSupportBot();
      if (supBot) {
        let topicId = activeTask.topic_id;

        if (!topicId) {
          // Find any existing topic this owner already has before creating a new one
          const priorWithTopic = await SupportTask.findOne({
            where: { owner_telegram_id: String(userId), topic_id: { [Op.not]: null } },
            order: [['created_at', 'DESC']],
          });
          if (priorWithTopic) {
            topicId = priorWithTopic.topic_id;
            await activeTask.update({ topic_id: topicId });
          } else {
            // Truly first-ever topic for this owner
            try {
              const topic = await supBot.telegram.createForumTopic(SUPPORT_CHAT_ID, `👤 ${activeTask.owner_name || 'Owner'}`);
              topicId = topic.message_thread_id;
              await activeTask.update({ topic_id: topicId });
              await supBot.telegram.sendMessage(
                SUPPORT_CHAT_ID,
                `🔔 <b>Existing Request</b>\n\n👤 Owner: <b>${activeTask.owner_name}</b>\n\n📝 Request:\n${activeTask.request_text || '(no text)'}`,
                { parse_mode: 'HTML', message_thread_id: topicId,
                  reply_markup: { inline_keyboard: [[{ text: '✅ Claim Case', callback_data: `sup_claim_${activeTask.id}` }]] } }
              );
            } catch (err) {
              logger.warn('Lazy topic creation (relay) failed:', err.message);
            }
          }
        }

        if (topicId) {
          const senderName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Owner';
          let delivered = false;
          try {
            await supBot.telegram.sendMessage(
              SUPPORT_CHAT_ID,
              `👤 <b>${senderName}:</b>\n${ctx.message.text}`,
              { parse_mode: 'HTML', message_thread_id: topicId }
            );
            delivered = true;
            if (activeTask.claimed_telegram_id) {
              await supBot.telegram.sendMessage(
                SUPPORT_CHAT_ID,
                `🔔 <a href="tg://user?id=${activeTask.claimed_telegram_id}">${activeTask.claimed_by || 'Support'}</a> — owner replied above`,
                { parse_mode: 'HTML', message_thread_id: topicId }
              ).catch(() => {});
            }
          } catch (err) {
            logger.warn('Owner→topic relay failed:', err.message);
          }
          if (delivered) {
            const deliveryMsg = activeTask.claimed_by
              ? `✅ Sent — <b>${activeTask.claimed_by}</b> will see this.`
              : `✅ Sent to support inbox.`;
            await ctx.reply(deliveryMsg, { parse_mode: 'HTML' }).catch(() => {});
          }
          return;
        }
      }
    }
  }

  await ctx.reply('Use /help to see available commands.');
};

// Relay owner photo/document to active support topic
async function relaySupportMedia(ctx, fileId, type) {
  const userId = ctx.from.id;
  const SupportTask = require('../models/SupportTask');
  const { Op } = require('sequelize');
  const { getSupportBot } = require('../services/notificationService');
  const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-1004396785239';
  const activeTask = await SupportTask.findOne({
    where: { owner_telegram_id: String(userId), status: { [Op.in]: ['pending', 'in_process', 'awaiting_approval'] } },
  });
  if (!activeTask?.topic_id) return false;
  const supBot = getSupportBot();
  if (!supBot) return false;
  const senderName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Owner';
  const caption = `👤 <b>${senderName}:</b>`;
  try {
    if (type === 'photo') {
      await supBot.telegram.sendPhoto(SUPPORT_CHAT_ID, fileId,
        { caption, parse_mode: 'HTML', message_thread_id: activeTask.topic_id });
    } else if (type === 'voice') {
      await supBot.telegram.sendVoice(SUPPORT_CHAT_ID, fileId,
        { caption, parse_mode: 'HTML', message_thread_id: activeTask.topic_id });
    } else {
      await supBot.telegram.sendDocument(SUPPORT_CHAT_ID, fileId,
        { caption, parse_mode: 'HTML', message_thread_id: activeTask.topic_id });
    }
  } catch (err) {
    logger.warn('Owner→topic media relay failed:', err.message);
  }
  return true;
}

const handleVoice = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const userId = ctx.from.id;
  if (specialTaskSessions.get(userId) === 'awaiting_text') {
    return ctx.reply('📝 Please type your request as text — voice messages cannot be used as the initial message.');
  }
  const fileId = ctx.message.voice.file_id;
  await relaySupportMedia(ctx, fileId, 'voice');
};

const handlePhoto = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const userId = ctx.from.id;
  if (specialTaskSessions.get(userId) === 'awaiting_text') {
    return ctx.reply('📝 Please type your request as text — photos cannot be used as the initial message.');
  }
  const session = orderSessions.get(userId);
  if (!session || session.step !== 'payment') {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    await relaySupportMedia(ctx, fileId, 'photo');
    return;
  }

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
  if (specialTaskSessions.get(userId) === 'awaiting_text') {
    return ctx.reply('📝 Please type your request as text — files cannot be used as the initial message.');
  }
  const session = orderSessions.get(userId);
  if (!session || session.step !== 'payment') {
    const fileId = ctx.message.document.file_id;
    const relayed = await relaySupportMedia(ctx, fileId, 'document');
    if (!relayed) {
      logger.debug(`Document from ${userId} (no active payment or support session)`);
      await ctx.reply('Use /help to see available commands.');
    }
    return;
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

module.exports = { handleText, handlePhoto, handleDocument, handleVoice };
