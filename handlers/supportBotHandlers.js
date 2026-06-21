const SupportTask = require('../models/SupportTask');
const logger = require('../utils/logger');
const { getMainBot } = require('../services/notificationService');

const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID || '-1004396785239';

// ── Member list helpers ───────────────────────────────────────────────────────

async function memberKeyboard(taskId, ownerTelegramId) {
  try {
    const SupportMember = require('../models/SupportMember');
    const User = require('../models/User');

    let members = [];
    if (ownerTelegramId) {
      const owner = await User.findOne({ where: { telegram_id: String(ownerTelegramId) } });
      if (owner?.block) {
        members = await SupportMember.findAll({ where: { block: owner.block }, order: [['id', 'ASC']] });
      }
    }
    // Fallback: show all members if owner has no block or block has no members
    if (!members.length) {
      members = await SupportMember.findAll({ order: [['id', 'ASC']] });
    }
    if (!members.length) {
      return [[{ text: '⚠️ No members configured', callback_data: 'noop' }]];
    }
    return members.map(m => [{
      text: `👤 ${m.name}  —  #${m.member_id}`,
      callback_data: `sup_pick_${taskId}_${m.id}`,
    }]);
  } catch {
    return [[{ text: '⚠️ Error loading members', callback_data: 'noop' }]];
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const supportStart = async (ctx) => {
  await ctx.reply(
    `👋 <b>OA Support Bot</b>\n\n` +
    `Owner requests arrive as dedicated topics.\n\n` +
    `<b>How to handle a case:</b>\n` +
    `1. Tap your name on the request to claim it\n` +
    `2. Chat directly in the topic — owner sees everything\n` +
    `3. Type <code>Done #YourMemberID</code> when finished`,
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

// Member clicks their own button on a new request
const supPickMember = async (ctx) => {
  const taskId   = parseInt(ctx.match[1], 10);
  const memberDbId = parseInt(ctx.match[2], 10);
  const task     = await SupportTask.findByPk(taskId);

  if (!task || ['closed', 'cancelled', 'call_ended'].includes(task.status)) {
    return ctx.answerCbQuery('⚠️ Case is no longer open.', { show_alert: true });
  }

  const SupportMember = require('../models/SupportMember');
  const member = await SupportMember.findByPk(memberDbId);
  if (!member) return ctx.answerCbQuery('⚠️ Member not found.', { show_alert: true });

  const wasUnclaimed = task.status === 'pending';

  await task.update({
    status:              'in_process',
    claimed_by:          member.name,
    claimed_telegram_id: String(ctx.from.id),
    claimed_at:          new Date(),
    updated_at:          new Date(),
  });

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: `👤 ${member.name}${member.member_id ? ` — #${member.member_id}` : ''} — Handling`, callback_data: 'noop' }],
        [{ text: '✅ Mark as Done',  callback_data: `sup_done_${taskId}` }],
        [{ text: '🔄 Switch Member', callback_data: `sup_switch_${taskId}` }],
      ],
    });
  } catch {}

  await ctx.answerCbQuery('Case claimed!');

  // Notify owner only on first claim (not when switching members)
  if (wasUnclaimed) {
    const mainBot = getMainBot();
    if (mainBot) {
      try {
        await mainBot.telegram.sendMessage(
          task.owner_telegram_id,
          `⏳ <b>${member.name} from support is on your case!</b>\n\nFeel free to send more details here anytime — they'll see everything.`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        logger.warn('Owner claim notify failed:', err.message);
      }
    }
  }
};

// Someone clicks "Switch Member" — re-shows all member buttons to re-assign
const supSwitchMember = async (ctx) => {
  const taskId = parseInt(ctx.match[1], 10);
  const task   = await SupportTask.findByPk(taskId);

  if (!task || ['closed', 'cancelled', 'call_ended'].includes(task.status)) {
    return ctx.answerCbQuery('⚠️ Case already closed.', { show_alert: true });
  }

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: await memberKeyboard(taskId, task.owner_telegram_id) });
  } catch {}

  await ctx.answerCbQuery('Select the member taking over.');
};

// Member clicks "✅ Mark as Done" — prompts to type Done #MemberID
const supDone = async (ctx) => {
  const taskId = parseInt(ctx.match[1], 10);
  const task   = await SupportTask.findByPk(taskId);

  if (!task || task.status !== 'in_process') {
    return ctx.answerCbQuery('⚠️ Case not active.', { show_alert: true });
  }

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch {}

  await ctx.answerCbQuery('Type Done #YourMemberID to close.');

  if (task.topic_id) {
    try {
      await ctx.telegram.sendMessage(
        SUPPORT_CHAT_ID,
        `✅ Ready to close this case?\n\nType <code>Done #YourMemberID</code> in this topic to notify the owner and log your ID.`,
        { parse_mode: 'HTML', message_thread_id: task.topic_id }
      );
    } catch {}
  }
};

// Relay messages from support topic → owner DM (text, photo, document, voice)
const handleSupportTopicMessage = async (ctx) => {
  if (String(ctx.chat?.id) !== String(SUPPORT_CHAT_ID)) return;
  if (ctx.message?.text?.startsWith('/')) return;

  const topicId = ctx.message.message_thread_id;
  if (!topicId) return;

  const { Op } = require('sequelize');
  const task = await SupportTask.findOne({
    where: { topic_id: topicId, status: { [Op.in]: ['pending', 'in_process', 'awaiting_approval', 'call_ended'] } },
    order: [['created_at', 'DESC']],
  });
  if (!task) return;

  const mainBot = getMainBot();
  if (!mainBot) return;

  // ── Media relay: topic → owner DM (not for call_ended — call is over) ────────
  if (!ctx.message.text) {
    if (task.status === 'call_ended') return;

    let rawFileId, mediaType;
    if (ctx.message.photo) {
      rawFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      mediaType = 'photo';
    } else if (ctx.message.document) {
      rawFileId = ctx.message.document.file_id;
      mediaType = 'document';
    } else if (ctx.message.voice) {
      rawFileId = ctx.message.voice.file_id;
      mediaType = 'voice';
    } else {
      return; // sticker, video note, etc — ignore
    }

    const caption = ctx.message.caption || '';
    const captionOpt = caption ? { caption: `💬 <b>Support:</b>\n${caption}`, parse_mode: 'HTML' } : { parse_mode: 'HTML' };

    try {
      // Telegram file_ids are bot-specific — resolve to a URL using supportBot token
      // so mainBot can re-upload the file to the owner's DM
      const fileInfo = await ctx.telegram.getFile(rawFileId);
      const fileUrl  = `https://api.telegram.org/file/bot${process.env.SUPPORT_BOT_TOKEN}/${fileInfo.file_path}`;

      if (mediaType === 'photo') {
        await mainBot.telegram.sendPhoto(task.owner_telegram_id, { url: fileUrl }, captionOpt);
      } else if (mediaType === 'document') {
        await mainBot.telegram.sendDocument(task.owner_telegram_id, { url: fileUrl }, captionOpt);
      } else if (mediaType === 'voice') {
        await mainBot.telegram.sendVoice(task.owner_telegram_id, { url: fileUrl }, captionOpt);
      }
    } catch (err) {
      logger.warn('Topic→owner media relay failed:', err.message);
    }
    return;
  }

  // ── "Done #MemberID" — closes the case ───────────────────────────────────────
  const doneMatch = ctx.message.text.match(/^Done\s+#(\S+)/i);
  if (doneMatch) {
    const memberId = doneMatch[1];

    if (task.status === 'call_ended') {
      // Call flow: owner already confirmed via "Call Ended" — close directly
      const closedAtDate = new Date();
      const durationMs   = closedAtDate - new Date(task.created_at);
      const durationMins = Math.round(durationMs / 60000);
      const durationStr  = durationMins >= 60
        ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`
        : `${durationMins}m`;

      await task.update({ member_id: memberId, status: 'closed', closed_at: closedAtDate, updated_at: closedAtDate });

      try {
        await ctx.telegram.sendMessage(
          SUPPORT_CHAT_ID,
          `✅ <b>Case Closed</b>\n\n🆔 Member ID: <b>#${memberId}</b>`,
          { parse_mode: 'HTML', message_thread_id: topicId }
        );
      } catch {}

      const TOPIC_FULLY_DONE = parseInt(process.env.TOPIC_FULLY_DONE || '7', 10);
      const closedAt = closedAtDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
      try {
        await ctx.telegram.sendMessage(
          SUPPORT_CHAT_ID,
          `📞 <b>Call Case Closed</b>\n\n` +
          `👤 Owner: <b>${task.owner_name}</b>\n` +
          `📝 Request: (call)\n\n` +
          `🛠 Handled by: <b>${task.claimed_by || '—'}</b>\n` +
          `🆔 Member ID: <b>#${memberId}</b>\n` +
          `⏱ Response time: <b>${durationStr}</b>\n` +
          `🕐 Closed at: ${closedAt}`,
          { parse_mode: 'HTML', message_thread_id: TOPIC_FULLY_DONE }
        );
      } catch {}

      try {
        await mainBot.telegram.sendMessage(
          task.owner_telegram_id,
          `✅ <b>Your support case has been fully closed.</b>\n\nThank you! If you need further help, feel free to open a new request.`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'main_menu' }]] } }
        );
      } catch {}

    } else {
      // Message flow: if already awaiting_approval, just update member ID — don't double-send
      if (task.status === 'awaiting_approval') {
        await task.update({ member_id: memberId, updated_at: new Date() });
        try {
          await ctx.telegram.sendMessage(
            SUPPORT_CHAT_ID,
            `✅ Member ID <b>#${memberId}</b> logged. Already waiting for owner confirmation.`,
            { parse_mode: 'HTML', message_thread_id: topicId }
          );
        } catch {}
        return;
      }

      await task.update({ member_id: memberId, status: 'awaiting_approval', updated_at: new Date() });

      try {
        await ctx.telegram.sendMessage(
          SUPPORT_CHAT_ID,
          `✅ Logged member ID <b>#${memberId}</b>. Waiting for owner confirmation…`,
          { parse_mode: 'HTML', message_thread_id: topicId,
            reply_markup: { inline_keyboard: [[{ text: '⏳ Waiting for owner confirmation…', callback_data: 'noop' }]] } }
        );
      } catch {}

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
    }
    return;
  }

  // ── Text relay: topic → owner DM (not for call_ended) ────────────────────────
  if (task.status === 'call_ended') return;

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

module.exports = {
  supportStart, getChatId, getTopicId,
  memberKeyboard,
  supPickMember, supSwitchMember, supDone,
  handleSupportTopicMessage,
};
