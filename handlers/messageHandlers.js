const logger = require('../utils/logger');
const User = require('../models/User');
const Order = require('../models/Order');
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

async function completeOrder(ctx, session, fileId, type) {
  // Save to DB first so we have an order ID
  const user = await User.findOne({ where: { telegram_id: ctx.from.id } });
  let order = null;
  if (user) {
    order = await Order.create({
      user_id:         user.id,
      owner_name:      session.owner_name,
      company_name:    session.company_name,
      email:           session.email,
      phone:           session.phone,
      location:        session.location,
      cable_pin:       session.cable_pin,
      stickers:        session.stickers,
      qty:             session.qty,
      shipping:        session.shipping,
      total:           session.total,
      status:          'active',
      payment_file_id: fileId,
      created_at:      new Date(),
      updated_at:      new Date(),
    });
  }

  const title = order ? `🎉 <b>New Device Order #${order.id}!</b>` : '🎉 <b>New Device Order!</b>';
  const summary = buildOrderSummary(session, title) + `\n\n👤 Telegram ID: ${ctx.from.id}`;

  if (type === 'photo') {
    await ctx.telegram.sendPhoto(ORDER_GROUP_ID, fileId, { caption: summary, parse_mode: 'HTML' });
  } else {
    await ctx.telegram.sendDocument(ORDER_GROUP_ID, fileId, { caption: summary, parse_mode: 'HTML' });
  }

  await ctx.reply(
    `✅ <b>Order Completed!</b>${order ? ` (Order #${order.id})` : ''}\n\n` +
    `Your payment has been received and order placed.\n\n` +
    `We'll contact you at:\n` +
    `📧 ${session.email}\n` +
    `📱 ${session.phone}\n\n` +
    `Track your order in <b>Order Devices → Active Orders</b>.\n\nUse /start to return to the menu.`,
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
    return ctx.reply('📎 Please send a <b>photo or PDF</b> of your payment screenshot.', { parse_mode: 'HTML' });
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
