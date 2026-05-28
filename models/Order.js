const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Order = sequelize.define('Order', {
  id:              { type: DataTypes.INTEGER,  primaryKey: true, autoIncrement: true },
  user_id:         { type: DataTypes.INTEGER,  allowNull: false },
  owner_name:      { type: DataTypes.STRING },
  company_name:    { type: DataTypes.STRING },
  email:           { type: DataTypes.STRING },
  phone:           { type: DataTypes.STRING },
  location:        { type: DataTypes.TEXT },
  cable_pin:       { type: DataTypes.STRING },
  stickers:        { type: DataTypes.STRING },
  qty:             { type: DataTypes.INTEGER },
  shipping:        { type: DataTypes.STRING },
  total:           { type: DataTypes.FLOAT },
  status:          { type: DataTypes.STRING, defaultValue: 'active' }, // active | delivered
  order_type:      { type: DataTypes.STRING, allowNull: true },
  items:           { type: DataTypes.TEXT, allowNull: true },
  tracking_link:   { type: DataTypes.STRING(1000), allowNull: true },
  payment_file_id: { type: DataTypes.STRING, allowNull: true },
  created_at:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'orders', timestamps: false });

module.exports = Order;
