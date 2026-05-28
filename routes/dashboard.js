const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const { Op } = require('sequelize');
const Order = require('../models/Order');
const User = require('../models/User');
const logger = require('../utils/logger');

const router = express.Router();

let _bot = null;
function setBot(bot) { _bot = bot; }

function basicAuth(req, res, next) {
  const password = process.env.DASHBOARD_PASSWORD || 'admin123';
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Device Order Admin"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const colon = decoded.indexOf(':');
  const pwd = colon >= 0 ? decoded.slice(colon + 1) : '';
  if (pwd !== password) {
    res.set('WWW-Authenticate', 'Basic realm="Device Order Admin"');
    return res.status(401).send('Invalid credentials');
  }
  next();
}

router.use(basicAuth);

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

router.get('/api/stats', async (req, res) => {
  try {
    const active = await Order.count({ where: { status: 'active' } });
    const delivered = await Order.count({ where: { status: 'delivered' } });
    res.json({ active, delivered, total: active + delivered });
  } catch (err) {
    logger.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

router.get('/api/orders', async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? { status } : {};
    const orders = await Order.findAll({
      where,
      order: [['created_at', 'DESC']],
    });

    const userIds = [...new Set(orders.map(o => o.user_id))];
    const users = userIds.length
      ? await User.findAll({ where: { id: userIds } })
      : [];
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const result = orders.map(o => {
      const u = userMap[o.user_id] || {};
      return {
        id: o.id,
        status: o.status,
        owner_name: o.owner_name,
        company_name: o.company_name,
        email: o.email,
        phone: o.phone,
        location: o.location,
        items: o.items,
        qty: o.qty,
        shipping: o.shipping,
        total: o.total,
        tracking_link: o.tracking_link,
        has_payment: !!o.payment_file_id,
        created_at: o.created_at,
        updated_at: o.updated_at,
        platform: u.platform || 'leader',
      };
    });

    res.json(result);
  } catch (err) {
    logger.error('Dashboard orders error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

router.get('/payment/:orderId', async (req, res) => {
  try {
    if (!_bot) return res.status(503).send('Bot not available');
    const order = await Order.findByPk(req.params.orderId);
    if (!order || !order.payment_file_id) {
      return res.status(404).send('Payment screenshot not found');
    }

    const fileLink = await _bot.telegram.getFileLink(order.payment_file_id);
    const url = typeof fileLink === 'string' ? fileLink : (fileLink.href || String(fileLink));

    const client = url.startsWith('https') ? https : http;
    client.get(url, (fileRes) => {
      const ct = fileRes.headers['content-type'] || 'image/jpeg';
      res.set('Content-Type', ct);
      res.set('Content-Disposition', `inline; filename="payment_order_${order.id}"`);
      fileRes.pipe(res);
    }).on('error', (err) => {
      logger.error('Payment proxy error:', err);
      res.status(500).send('Failed to load screenshot');
    });
  } catch (err) {
    logger.error('Dashboard payment error:', err);
    res.status(500).send('Failed to load payment');
  }
});

module.exports = { router, setBot };
