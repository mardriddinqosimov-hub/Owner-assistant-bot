const axios = require('axios');
const logger = require('../utils/logger');
const {
  orderPendingCustomQty,
  orderSessions,
  ORDER_STEPS,
  ORDER_PROMPTS,
  CANCEL_KB,
  showShippingSelection,
} = require('./callbackHandlers');

const ORDER_GROUP_ID = process.env.ORDER_GROUP_ID || '-5129310180';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildOrderSummary(s, title = '📋 <b>Order Confirmation</b>') {
  const shippingLabel = s.shipping === 'overnight' ? 'Overnight (+$100)' : 'Standard (FREE)';
  return (
    `${title}\n\n` +
    `👤 Owner: ${s.owner_name}\n` +
    `🏢 Company: ${s.company_name}\n` +
    `📧 Email: ${s.email}\n` +
    `📱 Phone: ${s.phone}\n` +
    `📍 Delivery: ${s.location}\n` +
    `🔌 Cable PIN: ${s.cable_pin}\n` +
    `🏷️ Stickers: ${s.stickers}\n\n` +
    `📦 ${s.qty}x PT30 ELD @ $179 each\n` +
    `Shipping: ${shippingLabel}\n` +
    `<b>Total: $${s.total}</b>`
  );
}

async function showConfirmation(ctx, session) {
  await ctx.reply(
    buildOrderSummary(session) + '\n\nPlease review and confirm your order:',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm Order', callback_data: 'order_confirm' }],
          [{ text: '✏️ Edit Info', callback_data: 'order_edit' }],
          [{ text: '❌ Cancel', callback_data: 'order_cancel' }],
        ],
      },
    }
  );
}

async function validateChequeDate(ctx, fileId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set — skipping cheque date validation');
    return true;
  }

  const file = await ctx.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const base64 = Buffer.from(resp.data).toString('base64');

  const ext = (file.file_path || '').split('.').pop().toLowerCase();
  let mediaType = 'image/jpeg';
  if (ext === 'png') mediaType = 'image/png';
  else if (ext === 'gif') mediaType = 'image/gif';
  else if (ext === 'webp') mediaType = 'image/webp';
  else if (ext === 'pdf') mediaType = 'application/pdf';

  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const sourceBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    messages: [{
      role: 'user',
      content: [
        sourceBlock,
        {
          type: 'text',
          text: `Today's date is ${today}. Is this cheque/check dated today? Reply with only YES or NO.`,
        },
      ],
    }],
  });

  const answer = (msg.content[0]?.text || '').trim().toUpperCase();
  logger.info(`Cheque date validation result: "${answer}" (today: ${today})`);
  return answer.startsWith('YES');
}

async function completeOrder(ctx, session, fileId, type) {
  const summary = buildOrderSummary(session, '🎉 <b>New Device Order!</b>') +
    `\n\n👤 Telegram ID: ${ctx.from.id}`;

  if (type === 'photo') {
    await ctx.telegram.sendPhoto(ORDER_GROUP_ID, fileId, { caption: summary, parse_mode: 'HTML' });
  } else {
    await ctx.telegram.sendDocument(ORDER_GROUP_ID, fileId, { caption: summary, parse_mode: 'HTML' });
  }

  await ctx.reply(
    `✅ <b>Order Completed!</b>\n\n` +
    `Your payment has been verified and order received.\n\n` +
    `We'll contact you at:\n` +
    `📧 ${session.email}\n` +
    `📱 ${session.phone}\n\n` +
    `Thank you! Use /start to return to the menu.`,
    { parse_mode: 'HTML' }
  );
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const handleText = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (ctx.message.text.startsWith('/')) return;

  const userId = ctx.from.id;

  // Custom quantity input
  if (orderPendingCustomQty.get(userId)) {
    const qty = parseInt(ctx.message.text.trim(), 10);
    if (!qty || qty < 1 || qty > 100) {
      return ctx.reply('Please enter a valid number between 1 and 100.');
    }
    orderPendingCustomQty.delete(userId);
    await ctx.reply(`You selected ${qty}x PT30. Choose shipping:`);
    return showShippingSelection(ctx, qty, false);
  }

  // Q&A order flow
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
    return ctx.reply('📎 Please send a <b>photo or PDF</b> of your cheque / payment screenshot.', { parse_mode: 'HTML' });
  }

  await ctx.reply('Use /help to see available commands.');
};

const handlePhoto = async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const userId = ctx.from.id;
  const session = orderSessions.get(userId);
  if (!session || session.step !== 'payment') return;

  await ctx.reply('🔍 Verifying payment date...');

  try {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;

    const valid = await validateChequeDate(ctx, fileId);
    if (!valid) {
      orderSessions.delete(userId);
      return ctx.reply(
        `❌ <b>Payment Not Accepted</b>\n\n` +
        `The cheque is not dated today.\n` +
        `Only today's dated cheques are accepted.\n\n` +
        `Use /start to restart your order.`,
        { parse_mode: 'HTML' }
      );
    }

    await completeOrder(ctx, session, fileId, 'photo');
    orderSessions.delete(userId);
  } catch (err) {
    logger.error('handlePhoto error:', err);
    await ctx.reply('❌ Error verifying payment. Please try again.');
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

  await ctx.reply('🔍 Verifying payment date...');

  try {
    const fileId = ctx.message.document.file_id;

    const valid = await validateChequeDate(ctx, fileId);
    if (!valid) {
      orderSessions.delete(userId);
      return ctx.reply(
        `❌ <b>Payment Not Accepted</b>\n\n` +
        `The cheque is not dated today.\n` +
        `Only today's dated cheques are accepted.\n\n` +
        `Use /start to restart your order.`,
        { parse_mode: 'HTML' }
      );
    }

    await completeOrder(ctx, session, fileId, 'document');
    orderSessions.delete(userId);
  } catch (err) {
    logger.error('handleDocument error:', err);
    await ctx.reply('❌ Error verifying payment. Please try again.');
  }
};

module.exports = { handleText, handlePhoto, handleDocument };
