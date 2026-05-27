const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Inspection = sequelize.define('Inspection', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id:         { type: DataTypes.INTEGER, allowNull: false },
  driver_id:       { type: DataTypes.STRING },
  driver_name:     { type: DataTypes.STRING },
  external_id:     { type: DataTypes.STRING }, // inspection_id from the ELD API
  inspection_date: { type: DataTypes.DATE },
  report_number:   { type: DataTypes.STRING },
  level:           { type: DataTypes.STRING },
  violations:      { type: DataTypes.INTEGER, defaultValue: 0 },
  result:          { type: DataTypes.STRING },
  details:         { type: DataTypes.TEXT }, // full API response as JSON string
  notified:        { type: DataTypes.BOOLEAN, defaultValue: false },
  created_at:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'inspections', timestamps: false });

module.exports = Inspection;
