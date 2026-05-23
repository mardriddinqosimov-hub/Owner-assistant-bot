const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  telegram_id: { type: DataTypes.BIGINT, unique: true, allowNull: false },
  company_name: { type: DataTypes.STRING },
  contact_email: { type: DataTypes.STRING },
  company_api_key: { type: DataTypes.TEXT },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  last_active: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'users', timestamps: false });

module.exports = User;
