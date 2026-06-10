const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Referral = sequelize.define('Referral', {
  id:                   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  owner_id:             { type: DataTypes.INTEGER, allowNull: false },
  referred_telegram_id: { type: DataTypes.BIGINT, allowNull: true },
  referred_name:        { type: DataTypes.STRING, allowNull: true },
  referred_company:     { type: DataTypes.STRING, allowNull: true },
  referred_phone:       { type: DataTypes.STRING, allowNull: true },
  trucks_count:         { type: DataTypes.INTEGER, allowNull: true },
  status:               { type: DataTypes.STRING, defaultValue: 'pending' }, // pending | confirmed | rejected | paid
  reward:               { type: DataTypes.DECIMAL(10, 2), defaultValue: 200.00 },
  payout_method:        { type: DataTypes.STRING, allowNull: true }, // card | credit | balance
  notes:                { type: DataTypes.TEXT, allowNull: true },
  created_at:           { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  confirmed_at:         { type: DataTypes.DATE, allowNull: true },
  paid_at:              { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'referrals', timestamps: false });

module.exports = Referral;
