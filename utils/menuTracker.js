const tracked = new Map(); // String(telegramId) → messageId

module.exports = {
  set: (telegramId, messageId) => tracked.set(String(telegramId), messageId),
  get: (telegramId) => tracked.get(String(telegramId)),
  del: (telegramId) => tracked.delete(String(telegramId)),
};
