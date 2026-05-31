const logger = require('../utils/logger');

let _accountingBot = null;
let _mainBot = null;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';

function setAccountingBot(bot) { _accountingBot = bot; }
function setMainBot(bot) { _mainBot = bot; }

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

async function notifyCustomer(telegramId, message, options = {}) {
  if (!_mainBot) return;
  try {
    await _mainBot.telegram.sendMessage(telegramId, message, options);
  } catch (err) {
    logger.warn('Customer notification failed:', err.message);
  }
}

module.exports = { setAccountingBot, setMainBot, notifyAdminNewOrder, notifyAdminText, notifyCustomer };
