const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WithdrawalRequest = sequelize.define('WithdrawalRequest', {
  id:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  owner_id:     { type: DataTypes.INTEGER, allowNull: false },
  amount:       { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  card_info:    { type: DataTypes.STRING, allowNull: true },
  status:       { type: DataTypes.STRING, defaultValue: 'pending' }, // pending | processed
  source:       { type: DataTypes.STRING, allowNull: true },         // 'balance' | 'referral'
  created_at:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  processed_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'withdrawal_requests',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['owner_id'],
      where: { status: 'pending' },
      name: 'unique_pending_withdrawal_per_owner',
    },
  ],
});

module.exports = WithdrawalRequest;
