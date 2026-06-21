const { DataTypes } = require('sequelize');
const database = require('../config/database');

const SupportMember = database.define('SupportMember', {
  id:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name:      { type: DataTypes.STRING(100), allowNull: false },
  member_id: { type: DataTypes.STRING(20),  allowNull: false, unique: true },
  created_at:{ type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName:  'support_members',
  timestamps: false,
});

module.exports = SupportMember;
