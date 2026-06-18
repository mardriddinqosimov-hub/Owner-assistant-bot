const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SupportTask = sequelize.define('SupportTask', {
  id:                  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  owner_user_id:       { type: DataTypes.INTEGER, allowNull: false },
  owner_telegram_id:   { type: DataTypes.STRING,  allowNull: false },
  owner_name:          { type: DataTypes.STRING },
  type:                { type: DataTypes.STRING,  allowNull: false }, // 'message' | 'call'
  request_text:        { type: DataTypes.TEXT },
  status:              { type: DataTypes.STRING,  defaultValue: 'pending' },
  // 'pending' → 'awaiting_approval' → 'closed'   (message)
  // 'pending' → 'call_ended' → 'closed'           (call)
  topic_id:            { type: DataTypes.INTEGER, allowNull: true },
  claimed_by:          { type: DataTypes.STRING,  allowNull: true },
  claimed_telegram_id: { type: DataTypes.STRING,  allowNull: true },
  claimed_at:          { type: DataTypes.DATE,    allowNull: true },
  closed_at:           { type: DataTypes.DATE,    allowNull: true },
  support_message_id:  { type: DataTypes.INTEGER },
  followup_message_id: { type: DataTypes.INTEGER },
  member_id:           { type: DataTypes.STRING },
  created_at:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'support_tasks', timestamps: false });

module.exports = SupportTask;
