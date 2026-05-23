const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DOTInspection = sequelize.define('DOTInspection', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false },
  driver_id: { type: DataTypes.STRING, allowNull: false },
  inspection_date: { type: DataTypes.DATE },
  inspection_location: { type: DataTypes.STRING },
  officer_badge_number: { type: DataTypes.STRING },
  logs_downloaded: { type: DataTypes.BOOLEAN, defaultValue: false },
  month_year: { type: DataTypes.STRING },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'dot_inspections', timestamps: false });

module.exports = DOTInspection;
