const logger = require('../utils/logger');

let _accountingBot = null;
let _mainBot = null;
let _adminBot = null;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';

function setAccountingBot(bot) { _accountingBot = bot; }
function setMainBot(bot)       { _mainBot = bot; }
function setAdminBot(bot)      { _adminBot = bot; }
function getMainBot()          { return _mainBot; }

async function notifyAdminNewOrder(fileId, fileType, caption) {
  const sender = _accountingBot || _mainBot;
  if (!sender) return;
  try {
    if (fileType === 'photo') {
      await sender.telegram.sendPhoto(ADMIN_ID, fileId, { caption, parse_mode: 'HTML' });
    } else {
      await sender.telegram.sendDocument(ADMIN_ID, fileId, { caption, parse_mode: 'HTML' });
    }
  } catch (err) {
    logger.warn('Admin order notification failed:', err.message);
  }
}

async function notifyAdminText(message) {
  const sender = _accountingBot || _mainBot;
  if (!sender) return;
  try {
    await sender.telegram.sendMessage(ADMIN_ID, message, { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn('Admin text notification failed:', err.message);
  }
}

async function notifyHeadAdmin(order) {
  if (!_adminBot) return;
  try {
    const CABLE = { vm: 'Volvo/Mack', obd: 'OBD2 Box', rp: 'RP1226', p9: '9-Pin' };
    let items = '';
    try {
      const it = JSON.parse(order.items || '{}');
      if (it.type === 'fullset') items = `${it.sets}× Full Set | ${CABLE[it.cable_type] || it.cable_type}`;
      else if (it.type === 'custom') {
        const p = [];
        if (it.pt30) p.push(`${it.pt30}× PT30`);
        for (const [k,n] of Object.entries(CABLE)) if (it[k]) p.push(`${it[k]}× ${n}`);
        items = p.join(', ');
      } else if (it.type === 'manual') items = `${it.qty||1}× ${it.device||'Device'} | ${it.cable||''}`;
    } catch { items = `${order.qty||1}× PT30`; }

    await _adminBot.telegram.sendMessage(
      ADMIN_ID,
      `🆕 <b>New Order #${order.id}</b>\n\n` +
      `👤 ${order.owner_name || '—'}\n` +
      `🏢 ${order.company_name || '—'}\n` +
      `📦 ${items}\n` +
      `💰 $${parseFloat(order.total || 0).toFixed(2)}\n` +
      `🏷 ${order.order_type === 'manual' ? 'Manual order' : 'Bot order'}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.warn('Head admin order notify failed:', err.message);
  }
}

async function notifyCustomer(telegramId, message, options = {}) {
  if (!_mainBot) return;
  try {
    await _mainBot.telegram.sendMessage(telegramId, message, options);
  } catch (err) {
    logger.warn('Customer notification failed:', err.message);
  }
}

module.exports = { setAccountingBot, setMainBot, setAdminBot, getMainBot, notifyAdminNewOrder, notifyAdminText, notifyHeadAdmin, notifyCustomer };
