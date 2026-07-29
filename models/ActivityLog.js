const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ActivityLog = sequelize.define('ActivityLog', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id:    { type: DataTypes.INTEGER, allowNull: false },
  action:     { type: DataTypes.STRING(64), allowNull: true },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'activity_logs', timestamps: false });

module.exports = ActivityLog;
