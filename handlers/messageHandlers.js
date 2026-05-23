const logger = require('../utils/logger');
const { orderPendingCustomQty, orderPendingInfo, showShippingSelection } = require('./callbackHandlers');

const handleText = async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const userId = ctx.from.id;

  // Custom quantity input
  if (orderPendingCustomQty.get(userId)) {
    const qty = parseInt(text.trim(), 10);
    if (!qty || qty < 1 || qty > 100) {
      return ctx.reply('Please enter a valid number between 1 and 100.');
    }
    orderPendingCustomQty.delete(userId);
    await ctx.reply(`You selected ${qty}x PT30. Choose shipping:`);
    return showShippingSelection(ctx, qty, false);
  }

  // Order info collection
  const pending = orderPendingInfo.get(userId);
  if (pending) {
    orderPendingInfo.delete(userId);
    const { qty, shipping, total } = pending;
    const shippingLabel = shipping === 'overnight' ? 'Overnight' : 'Standard';

    logger.info(`Order from ${userId}: ${qty}x PT30, ${shippingLabel}, $${total}\nDetails: ${text}`);

    await ctx.reply(
      `✅ <b>Order Received!</b>\n\n` +
      `${qty}x PT30 ELD — ${shippingLabel} shipping\n` +
      `Total: <b>$${total}</b>\n\n` +
      `We'll contact you shortly to confirm your order.\n` +
      `Use /start to return to the menu.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  logger.debug(`Message from ${userId}: ${text}`);
  await ctx.reply('Use /help to see available commands.');
};

const handleDocument = async (ctx) => {
  logger.info(`Document received from ${ctx.from.id}`);
  await ctx.reply('Document received. Use /help to see available commands.');
};

module.exports = { handleText, handleDocument };
