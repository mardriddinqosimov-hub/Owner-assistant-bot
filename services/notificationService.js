const logger = require('../utils/logger');

let _accountingBot  = null;
let _mainBot        = null;
let _adminBot       = null;
let _managementBot  = null;
let _supportBot     = null;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';

function setAccountingBot(bot)  { _accountingBot = bot; }
function setMainBot(bot)        { _mainBot = bot; }
function setAdminBot(bot)       { _adminBot = bot; }
function setManagementBot(bot)  { _managementBot = bot; }
function setSupportBot(bot)     { _supportBot = bot; }
function getMainBot()           { return _mainBot; }
function getAccountingBot()     { return _accountingBot; }
function getManagementBot()     { return _managementBot; }
function getSupportBot()        { return _supportBot; }

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
    const CABLE = { vm: '16-Pin Heavy Duty', obd: '16-Pin Light Duty', rp: '14-Pin', p9: '9-Pin' };
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

const BLOCKS = [
  { key: 'a',        label: '🟢 A block' },
  { key: 'd',        label: '🟣 D block' },
  { key: 'texas',    label: '🔴 Texas' },
  { key: 'missouri', label: '⚪️ Missouri' },
  { key: 'first_a',  label: '🔵 First-A' },
  { key: 'first_b',  label: '🟤 First-B' },
  { key: 'a1',       label: '🟡 A1' },
  { key: 'b1',       label: '🟠 B1' },
  { key: 'c1',       label: '⚫️ C1' },
];

async function notifyHeadAdminNewUser(user) {
  if (!_adminBot) return;
  try {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `ID ${user.telegram_id}`;
    const rows = [];
    for (let i = 0; i < BLOCKS.length; i += 3) {
      rows.push(BLOCKS.slice(i, i + 3).map(b => ({
        text: b.label,
        callback_data: `ha_setblock_${user.id}_${b.key}`,
      })));
    }
    rows.push([{ text: '👤 View Profile', callback_data: `ha_user_${user.id}` }]);
    await _adminBot.telegram.sendMessage(
      ADMIN_ID,
      `🆕 <b>New Owner Registered</b>\n\n` +
      `👤 ${name}\n` +
      `🆔 <code>${user.telegram_id}</code>\n\n` +
      `Assign to a block:`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    logger.warn('notifyHeadAdminNewUser failed:', err.message);
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

module.exports = { setAccountingBot, setMainBot, setAdminBot, setManagementBot, setSupportBot, getMainBot, getAccountingBot, getManagementBot, getSupportBot, notifyAdminNewOrder, notifyAdminText, notifyHeadAdmin, notifyHeadAdminNewUser, notifyCustomer };
