const SupportTask = require('../models/SupportTask');
const logger = require('../utils/logger');
const { getMainBot } = require('../services/notificationService');

const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-1004396785239';

const supportStart = async (ctx) => {
  await ctx.reply(
    `👋 <b>OA Support Bot</b>\n\n` +
    `You'll receive owner requests here as dedicated topics.\n\n` +
    `Click <b>✅ Claim Case</b> on a request to take it.\n` +
    `Then chat directly in the topic — messages relay to the owner.\n` +
    `Click <b>✅ Mark as Done</b> when the issue is resolved.`,
    { parse_mode: 'HTML' }
  );
};

const getChatId = async (ctx) => {
  await ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
};

const getTopicId = async (ctx) => {
  const threadId = ctx.message?.message_thread_id;
  if (threadId) {
    await ctx.reply(`Thread ID: <code>${threadId}</code>`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply('Send this command from inside a topic, not the General chat.');
  }
};

// Support member clicks "✅ Claim Case"
const supClaim = async (ctx) => {
  const taskId = parseInt(ctx.match[1], 10);
  const task = await SupportTask.findByPk(taskId);

  if (!task || task.status !== 'pending') {
    return ctx.answerCbQuery('⚠️ Already claimed or closed.', { show_alert: true });
  }

  const claimerName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
    || ctx.from.username
    || `ID ${ctx.from.id}`;

  await task.update({
    status:              'in_process',
    claimed_by:          claimerName,
    claimed_telegram_id: String(ctx.from.id),
    claimed_at:          new Date(),
    updated_at:          new Date(),
  });

  // Replace Claim button with claimed status + Mark Done button
  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: `👤 Claimed by ${claimerName}`, callback_data: 'noop' }],
        [{ text: '✅ Mark as Done', callback_data: `sup_done_${taskId}` }],
      ],
    });
  } catch {}

  await ctx.answerCbQuery('Case claimed!');

  // Notify owner
  const mainBot = getMainBot();
  if (mainBot) {
    try {
      await mainBot.telegram.sendMessage(
        task.owner_telegram_id,
        `⏳ <b>${claimerName} from support is on your case!</b>\n\nFeel free to send more details here anytime — they'll see everything.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      logger.warn('Owner claim notify failed:', err.message);
    }
  }
};

// Support member clicks "✅ Mark as Done"
const supDone = async (ctx) => {
  const taskId = parseInt(ctx.match[1], 10);
  const task = await SupportTask.findByPk(taskId);

  if (!task || task.status !== 'in_process') {
    return ctx.answerCbQuery('⚠️ Case not active.', { show_alert: true });
  }

  await task.update({ status: 'awaiting_approval', updated_at: new Date() });

  // Replace button with waiting indicator
  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: '⏳ Waiting for owner confirmation…', callback_data: 'noop' }],
      ],
    });
  } catch {}

  await ctx.answerCbQuery('Waiting for owner to confirm.');

  // Ask owner to confirm
  const mainBot = getMainBot();
  if (mainBot) {
    try {
      await mainBot.telegram.sendMessage(
        task.owner_telegram_id,
        `✅ <b>Has your request been fully resolved?</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Yes, Fully Done', callback_data: `task_approved_${taskId}` }],
              [{ text: '❌ Not Yet',         callback_data: `task_not_done_${taskId}` }],
            ],
          },
        }
      );
    } catch (err) {
      logger.warn('supDone owner notify failed:', err.message);
    }
  }

  // Post force-close option in topic for support team
  if (task.topic_id) {
    try {
      await ctx.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `⏳ Waiting for owner confirmation. If owner doesn't respond, use the button below.`,
        {
          parse_mode: 'HTML',
          message_thread_id: task.topic_id,
          reply_markup: { inline_keyboard: [[{ text: '🔒 Force Close', callback_data: `sup_force_close_${taskId}` }]] },
        }
      );
    } catch {}
  }
};

const supForceClose = async (ctx) => {
  const taskId = parseInt(ctx.match[1], 10);
  const task = await SupportTask.findByPk(taskId);

  if (!task || !['in_process', 'awaiting_approval'].includes(task.status)) {
    return ctx.answerCbQuery('⚠️ Case already closed.', { show_alert: true });
  }

  const closedAtDate = new Date();
  const durationMs   = closedAtDate - new Date(task.created_at);
  const durationMins = Math.round(durationMs / 60000);
  const durationStr  = durationMins >= 60
    ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`
    : `${durationMins}m`;

  await task.update({ status: 'closed', closed_at: closedAtDate, updated_at: closedAtDate });

  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}

  if (task.topic_id) {
    try {
      await ctx.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `🔒 <b>Case Force-Closed</b> by support team.`,
        { parse_mode: 'HTML', message_thread_id: task.topic_id }
      );
    } catch {}

    // Post summary to Fully Done topic
    const TOPIC_FULLY_DONE = parseInt(process.env.TOPIC_FULLY_DONE || '7', 10);
    const closedAt  = closedAtDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const handledBy = task.claimed_by || '—';
    const memberId  = task.member_id ? `#${task.member_id}` : '—';
    try {
      await ctx.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `🔒 <b>Case Force-Closed</b>\n\n` +
        `👤 Owner: <b>${task.owner_name}</b>\n` +
        `📝 Request: ${task.request_text || '—'}\n\n` +
        `🛠 Handled by: <b>${handledBy}</b>\n` +
        `🆔 Member ID: <b>${memberId}</b>\n` +
        `⏱ Response time: <b>${durationStr}</b>\n` +
        `🕐 Closed at: ${closedAt}`,
        { parse_mode: 'HTML', message_thread_id: TOPIC_FULLY_DONE }
      );
    } catch {}
  }

  // Notify owner
  const mainBot = getMainBot();
  if (mainBot) {
    try {
      await mainBot.telegram.sendMessage(
        task.owner_telegram_id,
        `🔒 <b>Your support case has been closed by the support team.</b>\n\nIf you need further help, feel free to open a new request.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] } }
      );
    } catch {}
  }

  await ctx.answerCbQuery('Case force-closed.');
};

// Relay messages from support topic → owner DM (text, photo, document)
const handleSupportTopicMessage = async (ctx) => {
  if (String(ctx.chat?.id) !== String(SUPPORT_CHAT_ID)) return;
  if (ctx.message?.text?.startsWith('/')) return;

  const topicId = ctx.message.message_thread_id;
  if (!topicId) return;

  const { Op } = require('sequelize');
  const task = await SupportTask.findOne({
    where: { topic_id: topicId, status: { [Op.in]: ['pending', 'in_process', 'awaiting_approval'] } },
    order: [['created_at', 'DESC']],
  });
  if (!task) return;

  const mainBot = getMainBot();
  if (!mainBot) return;

  // ── Photo/document relay: topic → owner DM ──────────────────────────────────
  if (!ctx.message.text) {
    const caption = ctx.message.caption || '';
    try {
      if (ctx.message.photo) {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await mainBot.telegram.sendPhoto(task.owner_telegram_id, fileId,
          { caption: caption ? `💬 <b>Support:</b>\n${caption}` : undefined, parse_mode: 'HTML' });
      } else if (ctx.message.document) {
        await mainBot.telegram.sendDocument(task.owner_telegram_id, ctx.message.document.file_id,
          { caption: caption ? `💬 <b>Support:</b>\n${caption}` : undefined, parse_mode: 'HTML' });
      } else if (ctx.message.voice) {
        await mainBot.telegram.sendVoice(task.owner_telegram_id, ctx.message.voice.file_id,
          { caption: caption ? `💬 <b>Support:</b>\n${caption}` : undefined, parse_mode: 'HTML' });
      }
    } catch (err) {
      logger.warn('Topic→owner media relay failed:', err.message);
    }
    return;
  }

  // Detect "Done #XXXX" — extract member ID and trigger done flow
  const doneMatch = ctx.message.text.match(/^Done\s+#(\S+)/i);
  if (doneMatch) {
    const memberId = doneMatch[1]; // e.g. "M450"
    await task.update({ member_id: memberId, status: 'awaiting_approval', updated_at: new Date() });

    // Acknowledge in topic
    try {
      await ctx.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `✅ Logged member ID <b>#${memberId}</b>. Waiting for owner confirmation…`,
        { parse_mode: 'HTML', message_thread_id: topicId,
          reply_markup: { inline_keyboard: [[{ text: '⏳ Waiting for owner confirmation…', callback_data: 'noop' }]] } }
      );
    } catch {}

    // Ask owner to confirm
    try {
      await mainBot.telegram.sendMessage(
        task.owner_telegram_id,
        `✅ <b>Has your request been fully resolved?</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Yes, Fully Done', callback_data: `task_approved_${task.id}` }],
              [{ text: '❌ Not Yet',         callback_data: `task_not_done_${task.id}` }],
            ],
          },
        }
      );
    } catch (err) {
      logger.warn('Done trigger owner notify failed:', err.message);
    }
    return;
  }

  try {
    await mainBot.telegram.sendMessage(
      task.owner_telegram_id,
      `💬 <b>Support:</b>\n${ctx.message.text}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.warn('Topic→owner relay failed:', err.message);
  }
};

module.exports = { supportStart, getChatId, getTopicId, supClaim, supDone, supForceClose, handleSupportTopicMessage };
