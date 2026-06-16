const SupportTask = require('../models/SupportTask');
const logger = require('../utils/logger');

const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-1004396785239';

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

const supportStart = async (ctx) => {
  await ctx.reply(
    `👋 <b>OA Support Bot</b>\n\n` +
    `You'll receive owner requests here.\n\n` +
    `📩 <b>Message requests:</b>\n` +
    `Reply to the request message with:\n<code>done [yourMemberID]</code>\n\n` +
    `📞 <b>Call requests:</b>\n` +
    `After the call ends, reply to the "Enter your ID" message with your Member ID.`,
    { parse_mode: 'HTML' }
  );
};

const handleSupportText = async (ctx) => {
  if (String(ctx.chat.id) !== String(SUPPORT_CHAT_ID)) return;

  const text = ctx.message.text?.trim();
  if (!text || text.startsWith('/')) return;

  // Only process replies — this is how members identify which case they're handling
  const repliedToId = ctx.message.reply_to_message?.message_id;
  if (!repliedToId) return;

  const { getMainBot } = require('../services/notificationService');
  const mainBot = getMainBot();

  // Extract member ID: supports "done 123" or just "123"
  const memberId = text.toLowerCase().startsWith('done ')
    ? text.slice(5).trim()
    : text.trim();

  // ── Case 1: Support marking a message task done ───────────────────────────
  const messageTask = await SupportTask.findOne({
    where: { support_message_id: repliedToId, status: 'pending', type: 'message' },
  });

  if (messageTask) {
    await messageTask.update({ member_id: memberId, status: 'awaiting_approval', updated_at: new Date() });

    if (mainBot) {
      try {
        await mainBot.telegram.sendMessage(
          messageTask.owner_telegram_id,
          `✅ <b>Your request has been handled!</b>\n\nIs your request fully done?`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Yes, Fully Done', callback_data: `task_approved_${messageTask.id}` }],
                [{ text: '❌ Not Yet',         callback_data: `task_not_done_${messageTask.id}` }],
              ],
            },
          }
        );
      } catch (err) {
        logger.warn('Failed to notify owner for message task:', err.message);
      }
    }

    try {
      await ctx.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `⏙️ <b>In Process</b>\n\n` +
        `👤 Owner: <b>${messageTask.owner_name}</b>\n` +
        `🔖 Member ID: <b>${memberId}</b>\n\n` +
        `Waiting for owner to confirm the request is done.`,
        { parse_mode: 'HTML', message_thread_id: parseInt(process.env.TOPIC_IN_PROCESS || '15') }
      );
    } catch {}
    return;
  }

  // ── Case 2: Support entering ID after call ended ──────────────────────────
  const callTask = await SupportTask.findOne({
    where: { followup_message_id: repliedToId, status: 'call_ended' },
  });

  if (callTask) {
    await callTask.update({ member_id: memberId, status: 'closed', updated_at: new Date() });

    try {
      await ctx.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `✅ <b>Case Fully Closed</b>\n\n` +
        `📞 Call — handled by Member ID: <b>${memberId}</b>\n` +
        `👤 Owner: <b>${callTask.owner_name}</b>`,
        { parse_mode: 'HTML', message_thread_id: parseInt(process.env.TOPIC_FULLY_DONE || '7') }
      );
    } catch {}
  }
};

module.exports = { supportStart, handleSupportText, getTopicId, getChatId };
