const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Setting = sequelize.define('Setting', {
  key:        { type: DataTypes.STRING, primaryKey: true },
  value:      { type: DataTypes.TEXT },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'settings', timestamps: false });

async function getSetting(key, defaultValue = null) {
  const s = await Setting.findByPk(key);
  return s ? s.value : defaultValue;
}

async function setSetting(key, value) {
  await Setting.upsert({ key, value: String(value), updated_at: new Date() });
}

module.exports = { Setting, getSetting, setSetting };
