const Order = require('../models/Order');
const { notifyAdminText, notifyHeadAdmin } = require('../services/notificationService');
const logger = require('../utils/logger');

const ORDER_GROUP_ID = process.env.ORDER_GROUP_ID || '-5129310180';

function field(text, ...labels) {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*:?\\s*(.+)`, 'im');
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function isManualOrder(text) {
  return (
    /company\s*name\s*:/i.test(text) &&
    (/type\s*of\s*device\s*:/i.test(text) || /first\s*name\s*:/i.test(text))
  );
}

async function handleGroupMessage(ctx) {
  if (String(ctx.chat?.id) !== String(ORDER_GROUP_ID)) return;

  const text = ctx.message?.text || ctx.message?.caption || '';
  if (!text || !isManualOrder(text)) return;

  try {
    const firstName   = field(text, 'First name', 'First Name');
    const lastName    = field(text, 'Last name', 'Last Name');
    const ownerName   = [firstName, lastName].filter(Boolean).join(' ') || 'Manual Order';
    const companyName = field(text, 'Company Name', 'Company name', 'Company');
    const email       = field(text, 'Email', 'E-mail');
    const phone       = field(text, 'Phone no', 'Phone number', 'Phone');
    const location    = field(text, 'Delivery location', 'Delivery Location', 'Delivery address', 'Address');
    const cableRaw    = field(text, 'Type of cable', 'Cable type', 'Cable');
    const deviceRaw   = field(text, 'Type of device', 'Device type', 'Device');
    const qtyRaw      = field(text, 'Quantity', 'Qty');
    const stickersRaw = field(text, 'Stickers', 'Sticker');
    const shippingRaw = field(text, 'Shipping', 'Shipping type');

    const qty      = parseInt(qtyRaw) || 1;
    const shipping = /overnight/i.test(shippingRaw) ? 'overnight' : 'standard';

    const itemsJson = JSON.stringify({
      type: 'manual',
      device: deviceRaw,
      cable: cableRaw,
      qty,
      stickers: stickersRaw,
    });

    const order = await Order.create({
      user_id:      null,
      owner_name:   ownerName,
      company_name: companyName,
      email,
      phone,
      location,
      qty,
      shipping,
      total:        0,
      order_type:   'manual',
      items:        itemsJson,
      status:       'active',
      created_at:   new Date(),
      updated_at:   new Date(),
    });

    logger.info(`Manual order #${order.id} created from group message`);

    const notice =
      `📋 <b>New Manual Order #${order.id}</b>\n\n` +
      `👤 ${ownerName}\n` +
      `🏢 ${companyName}\n` +
      `📧 ${email}\n` +
      `📱 ${phone}\n` +
      `📍 ${location}\n\n` +
      `📱 Device: ${deviceRaw}\n` +
      `🔌 Cable: ${cableRaw}\n` +
      `📦 Qty: ${qty}\n` +
      `🏷 Stickers: ${stickersRaw}\n` +
      `🚚 Shipping: ${shippingRaw}\n\n` +
      `⚠️ <b>Manual order — no payment file</b>`;

    await notifyAdminText(notice);
    await notifyHeadAdmin(order);
  } catch (err) {
    logger.error('handleGroupMessage error:', err);
  }
}

module.exports = { handleGroupMessage };
