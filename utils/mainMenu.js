const User = require('../models/User');
const menuTracker = require('./menuTracker');

const MENU_KEYBOARD = [
  [{ text: '👥 View Drivers',    callback_data: 'drivers_list' }],
  [{ text: '📦 Order Devices',   callback_data: 'order_devices_start' }],
  [{ text: '🚔 DOT Inspections', callback_data: 'dot_menu' }],
  [{ text: '💰 My Referrals',    callback_data: 'referral_menu' }],
  [{ text: '🛠️ Special Task',    callback_data: 'special_task_menu' }],
  [{ text: '🔄 Change Team',     callback_data: 'change_team' }],
  [{ text: '❓ Help',            callback_data: 'help_menu' }],
];

async function sendMainMenu(bot, telegramId) {
  const user = await User.findOne({ where: { telegram_id: String(telegramId) } });
  const hasKey = user && !!user.company_api_key;
  const companyLine = hasKey
    ? `✅ Connected to <b>${user.company_name || 'ELD'}</b>`
    : '⚠️ No company connected. Use /setapi YOUR_COMPANY_KEY';

  const msg = await bot.telegram.sendMessage(
    telegramId,
    `👋 <b>OWNER ASSISTANT BOT</b>\n\n${companyLine}`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: MENU_KEYBOARD },
    }
  );
  menuTracker.set(telegramId, msg.message_id);
  return msg;
}

module.exports = { sendMainMenu };
