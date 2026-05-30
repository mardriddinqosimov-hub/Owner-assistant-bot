const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const { Op } = require('sequelize');
const Order = require('../models/Order');
const User = require('../models/User');
const { getSetting, setSetting } = require('../models/Setting');
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
router.use(express.json());

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

// ── Management status ─────────────────────────────────────────────────────────
router.get('/api/management/status', async (req, res) => {
  try {
    const open = await getSetting('orders_open', 'true');
    const message = await getSetting('orders_closed_message', '');
    res.json({ open: open === 'true', message });
  } catch (err) {
    logger.error('Management status error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/api/management/open', async (req, res) => {
  try {
    await setSetting('orders_open', 'true');
    res.json({ success: true });
  } catch (err) {
    logger.error('Management open error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/api/management/close', async (req, res) => {
  try {
    const msg = (req.body.message || '').trim() || 'Stores are temporarily closed. Please try again later.';
    await setSetting('orders_open', 'false');
    await setSetting('orders_closed_message', msg);
    res.json({ success: true });
  } catch (err) {
    logger.error('Management close error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ── Reports summary ───────────────────────────────────────────────────────────
router.get('/api/reports/summary', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek  = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [allOrders, recentOrders] = await Promise.all([
      Order.findAll({ attributes: ['total', 'created_at', 'status'] }),
      Order.findAll({
        where: { created_at: { [Op.gte]: thirtyDaysAgo } },
        attributes: ['total', 'created_at', 'status'],
        order: [['created_at', 'ASC']],
      }),
    ]);

    // Build daily buckets for last 30 days
    const dayMap = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      dayMap[d.toISOString().split('T')[0]] = { count: 0, revenue: 0 };
    }

    let todayCount = 0, todayRev = 0;
    let weekCount  = 0, weekRev  = 0;
    let monthCount = 0, monthRev = 0;
    let totalRev   = 0;

    for (const o of allOrders) {
      const rev = parseFloat(o.total || 0);
      totalRev += rev;
      const d = new Date(o.created_at);
      if (d >= startOfDay)   { todayCount++; todayRev += rev; }
      if (d >= startOfWeek)  { weekCount++;  weekRev  += rev; }
      if (d >= startOfMonth) { monthCount++; monthRev += rev; }
    }

    for (const o of recentOrders) {
      const key = new Date(o.created_at).toISOString().split('T')[0];
      if (dayMap[key]) {
        dayMap[key].count++;
        dayMap[key].revenue += parseFloat(o.total || 0);
      }
    }

    res.json({
      today:        { count: todayCount, revenue: todayRev },
      week:         { count: weekCount,  revenue: weekRev  },
      month:        { count: monthCount, revenue: monthRev },
      totalRevenue: totalRev,
      daily: Object.entries(dayMap).map(([date, d]) => ({ date, ...d })),
    });
  } catch (err) {
    logger.error('Reports summary error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

module.exports = { router, setBot };
