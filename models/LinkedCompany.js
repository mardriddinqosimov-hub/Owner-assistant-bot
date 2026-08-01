const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const LinkedCompany = sequelize.define('LinkedCompany', {
  user_id:         { type: DataTypes.INTEGER, allowNull: false },
  company_name:    { type: DataTypes.STRING },
  company_api_key: { type: DataTypes.STRING, allowNull: false },
  platform:        { type: DataTypes.STRING },
}, {
  tableName: 'linked_companies',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { fields: ['user_id'] },
    { unique: true, fields: ['user_id', 'company_api_key'] },
  ],
});

module.exports = LinkedCompany;
