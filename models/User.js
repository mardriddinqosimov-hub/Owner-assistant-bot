const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  telegram_id: { type: DataTypes.BIGINT, unique: true, allowNull: false },
  first_name:   { type: DataTypes.STRING, allowNull: true },
  last_name:    { type: DataTypes.STRING, allowNull: true },
  username:     { type: DataTypes.STRING, allowNull: true },
  owner_name:       { type: DataTypes.STRING, allowNull: true },
  phone:            { type: DataTypes.STRING, allowNull: true },
  delivery_address: { type: DataTypes.TEXT, allowNull: true },
  company_name: { type: DataTypes.STRING },
  contact_email: { type: DataTypes.STRING },
  company_api_key: { type: DataTypes.TEXT },
  platform:     { type: DataTypes.STRING, allowNull: true },
  role:         { type: DataTypes.STRING, defaultValue: 'unknown' }, // owner | safety | unknown
  blocked:      { type: DataTypes.BOOLEAN, defaultValue: false },
  referral_balance: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  deleted_at:       { type: DataTypes.DATE, allowNull: true },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  last_active: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'users', timestamps: false });

module.exports = User;
