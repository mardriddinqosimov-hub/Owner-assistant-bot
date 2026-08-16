const User = require('../models/User');
const menuTracker = require('./menuTracker');

function buildMenuKeyboard(user) {
  const hasKey = user && !!user.company_api_key;
  const isOwner = user?.role === 'owner';
  const keyboard = [];
  if (hasKey) {
    keyboard.push([{ text: `🏢 ${user.company_name || 'My Companies'}  ▾`, callback_data: 'my_companies' }]);
  }
  keyboard.push(
    [{ text: '👥 View Drivers',    callback_data: 'drivers_list' }],
    [{ text: '🚔 DOT Inspections', callback_data: 'dot_menu' }],
    isOwner
      ? [{ text: '📦 Order Devices  · 🔴 coming soon', callback_data: 'coming_soon' }]
      : [{ text: '📦 Order Devices',                   callback_data: 'order_devices_start' }],
    isOwner
      ? [{ text: '💰 My Referrals  · 🔴 coming soon',  callback_data: 'coming_soon' }]
      : [{ text: '💰 My Referrals',                    callback_data: 'referral_menu' }],
  );
  if (!hasKey) keyboard.push([{ text: '🔄 Change Team', callback_data: 'change_team' }]);
  keyboard.push([{ text: '❓ Help', callback_data: 'help_menu' }]);
  return keyboard;
}

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
      reply_markup: { inline_keyboard: buildMenuKeyboard(user) },
    }
  );
  menuTracker.set(telegramId, msg.message_id);
  return msg;
}

module.exports = { sendMainMenu };
