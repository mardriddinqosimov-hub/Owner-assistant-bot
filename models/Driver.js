const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Driver = sequelize.define('Driver', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id: { type: DataTypes.INTEGER, allowNull: false },
  driver_id: { type: DataTypes.STRING, allowNull: false },
  driver_name: { type: DataTypes.STRING, allowNull: false },
  truck_number: { type: DataTypes.STRING },
  eld_provider: { type: DataTypes.STRING },
  current_status: { type: DataTypes.STRING },
  speed: { type: DataTypes.FLOAT },
  latitude: { type: DataTypes.FLOAT },
  longitude: { type: DataTypes.FLOAT },
  location_string: { type: DataTypes.STRING(500) },
  drive_remaining: { type: DataTypes.INTEGER },
  shift_remaining: { type: DataTypes.INTEGER },
  break_remaining: { type: DataTypes.INTEGER },
  cycle_remaining: { type: DataTypes.INTEGER },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'drivers', timestamps: false });

module.exports = Driver;
