const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const { Op } = require('sequelize');
const Order              = require('../models/Order');
const User               = require('../models/User');
const Referral           = require('../models/Referral');
const WithdrawalRequest  = require('../models/WithdrawalRequest');
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

router.get('/api/quick-stats', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [activeOrders, todayOrders, pendingReferrals] = await Promise.all([
      Order.count({ where: { status: 'active' } }),
      Order.count({ where: { created_at: { [Op.gte]: startOfDay } } }),
      Referral.count({ where: { status: 'confirmed' } }),
    ]);
    res.json({ activeOrders, todayOrders, pendingReferrals });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
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

    const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))];
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

// ── Referrals list ────────────────────────────────────────────────────────────
router.get('/api/referrals', async (req, res) => {
  try {
    const refs = await Referral.findAll({ order: [['created_at', 'DESC']] });
    const owners = await User.findAll({ attributes: ['id', 'first_name', 'last_name', 'username', 'owner_name', 'card_info'] });
    const ownerMap = {};
    owners.forEach(u => {
      ownerMap[u.id] = {
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.owner_name || null,
        card_info: u.card_info || null,
      };
    });
    const result = refs.map(r => ({
      ...r.dataValues,
      owner_name: ownerMap[r.owner_id]?.name || null,
      owner_card: ownerMap[r.owner_id]?.card_info || null,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Referral payout (from dashboard) ─────────────────────────────────────────
router.post('/api/referral-payout', express.json(), async (req, res) => {
  try {
    const { refId, method } = req.body; // method: 'card' | 'credit'
    if (!refId || !['card', 'credit'].includes(method)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    const ref = await Referral.findByPk(refId);
    if (!ref) return res.status(404).json({ error: 'Referral not found' });
    if (ref.status === 'paid') return res.status(400).json({ error: 'Already processed' });
    if (ref.status !== 'confirmed') return res.status(400).json({ error: 'Referral must be confirmed before payout' });

    await ref.update({ status: 'paid', payout_method: method, paid_at: new Date() });

    const owner = await User.findByPk(ref.owner_id);
    let newBal = 0;
    if (owner) {
      newBal = Math.max(0, parseFloat(owner.referral_balance || 0) - parseFloat(ref.reward));
      await owner.update({ referral_balance: newBal.toFixed(2) });

      if (_bot) {
        try {
          const msg = method === 'card'
            ? `💳 <b>Referral Payout Sent!</b>\n\n$${parseFloat(ref.reward).toFixed(2)} has been sent to your card for referral #${ref.id} (${ref.referred_company || ref.referred_name}).\n\nRemaining balance: <b>$${newBal.toFixed(2)}</b>`
            : `📦 <b>Referral Credit Applied!</b>\n\n$${parseFloat(ref.reward).toFixed(2)} has been applied as service credit for referral #${ref.id} (${ref.referred_company || ref.referred_name}).\n\nRemaining balance: <b>$${newBal.toFixed(2)}</b>`;
          await _bot.telegram.sendMessage(owner.telegram_id, msg, { parse_mode: 'HTML' });
        } catch {}
      }
    }

    res.json({ ok: true, newBalance: newBal.toFixed(2) });
  } catch (err) {
    logger.error('Referral payout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Referral balances (all owners) ────────────────────────────────────────────
router.get('/api/referral-balances', async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'first_name', 'last_name', 'username', 'owner_name', 'company_name', 'referral_balance', 'card_info'],
      where: { deleted_at: null },
    });
    const allRefs = await Referral.findAll({ attributes: ['owner_id', 'reward', 'status'] });

    const result = users
      .map(u => {
        const refs      = allRefs.filter(r => r.owner_id === u.id);
        const total     = refs.length;
        const totalEarned = refs
          .filter(r => ['confirmed', 'paid'].includes(r.status))
          .reduce((sum, r) => sum + parseFloat(r.reward || 0), 0);
        return {
          id:            u.id,
          name:          [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.owner_name || null,
          company:       u.company_name || '—',
          balance:       parseFloat(u.referral_balance || 0),
          total_refs:    total,
          total_earned:  totalEarned,
          card_info:     u.card_info ? '••••' + u.card_info.replace(/\s/g, '').slice(-4) : null,
        };
      })
      .filter(u => u.total_refs > 0 || u.balance > 0);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Keep referral reward in owner balance ─────────────────────────────────────
router.post('/api/referral-keep', express.json(), async (req, res) => {
  try {
    const { refId } = req.body;
    if (!refId) return res.status(400).json({ error: 'Missing refId' });

    const ref = await Referral.findByPk(refId);
    if (!ref) return res.status(404).json({ error: 'Referral not found' });
    if (ref.status === 'paid') return res.status(400).json({ error: 'Already processed' });
    if (ref.status !== 'confirmed') return res.status(400).json({ error: 'Referral must be confirmed before keeping balance' });

    await ref.update({ status: 'paid', payout_method: 'balance', paid_at: new Date() });

    // Balance was already added when management confirmed — just notify owner
    const owner = await User.findByPk(ref.owner_id);
    const currentBal = parseFloat(owner?.referral_balance || 0);
    if (owner && _bot) {
      try {
        await _bot.telegram.sendMessage(
          owner.telegram_id,
          `💰 <b>Reward Kept in Balance!</b>\n\n$${parseFloat(ref.reward).toFixed(2)} for referral #${ref.id} (${ref.referred_company || ref.referred_name}) is in your balance.\n\nCurrent balance: <b>$${currentBal.toFixed(2)}</b>\n\nYou can withdraw it anytime from the Referrals menu.`,
          { parse_mode: 'HTML' }
        );
      } catch {}
    }

    res.json({ ok: true, newBalance: currentBal.toFixed(2) });
  } catch (err) {
    logger.error('Referral keep error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Withdrawal requests list ──────────────────────────────────────────────────
router.get('/api/withdrawal-requests', async (req, res) => {
  try {
    const requests = await WithdrawalRequest.findAll({ order: [['created_at', 'DESC']] });
    const owners = await User.findAll({ attributes: ['id', 'first_name', 'last_name', 'username', 'owner_name', 'company_name'] });
    const ownerMap = Object.fromEntries(owners.map(u => [u.id, {
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.owner_name || null,
      company: u.company_name || '—',
    }]));
    res.json(requests.map(r => ({
      ...r.dataValues,
      owner_name:    ownerMap[r.owner_id]?.name || `ID ${r.owner_id}`,
      owner_company: ownerMap[r.owner_id]?.company || '—',
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Mark withdrawal request as processed ─────────────────────────────────────
router.post('/api/withdrawal-done/:id', async (req, res) => {
  try {
    const wr = await WithdrawalRequest.findByPk(req.params.id);
    if (!wr) return res.status(404).json({ error: 'Not found' });
    await wr.update({ status: 'processed', processed_at: new Date() });

    const owner = await User.findByPk(wr.owner_id);
    if (owner) {
      const newBal = Math.max(0, parseFloat(owner.referral_balance || 0) - parseFloat(wr.amount || 0));
      await owner.update({ referral_balance: newBal.toFixed(2) });

      if (_bot) {
        try {
          const last4 = wr.card_info ? wr.card_info.replace(/\s/g, '').slice(-4) : '????';
          await _bot.telegram.sendMessage(
            owner.telegram_id,
            `💸 <b>Payment Sent!</b>\n\n` +
            `<b>$${parseFloat(wr.amount).toFixed(2)}</b> has been sent to your card ending in <b>${last4}</b>.\n\n` +
            `Your new balance: <b>$${newBal.toFixed(2)}</b>`,
            { parse_mode: 'HTML' }
          );
        } catch {}
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Users list ───────────────────────────────────────────────────────────────
router.get('/api/users', async (req, res) => {
  try {
    const users = await User.findAll({ order: [['created_at', 'DESC']] });
    const orderCounts = await Order.findAll({
      attributes: ['user_id', [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'cnt']],
      where: { user_id: { [Op.not]: null } },
      group: ['user_id'],
    });
    const countMap = Object.fromEntries(orderCounts.map(r => [r.user_id, parseInt(r.get('cnt'))]));

    res.json(users.map(u => ({
      id:           u.id,
      telegram_id:  String(u.telegram_id),
      first_name:   u.first_name || '',
      last_name:    u.last_name  || '',
      username:     u.username   || '',
      company_name: u.company_name || '',
      contact_email:u.contact_email || '',
      platform:     u.platform || '',
      role:         u.role || 'unknown',
      blocked:      !!u.blocked,
      orders:       countMap[u.id] || 0,
      created_at:   u.created_at,
      last_active:  u.last_active,
    })));
  } catch (err) {
    logger.error('Users list error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.patch('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { role, blocked } = req.body;
    const update = {};
    if (role !== undefined) update.role = role;
    if (blocked !== undefined) update.blocked = blocked;
    await user.update(update);
    res.json({ success: true });
  } catch (err) {
    logger.error('User update error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ── Update tracking link ──────────────────────────────────────────────────────
router.patch('/api/orders/:id/tracking', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await order.update({ tracking_link: req.body.tracking_link || null });
    res.json({ success: true });
  } catch (err) {
    logger.error('Update tracking error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ── Mark order delivered ──────────────────────────────────────────────────────
router.post('/api/orders/:id/deliver', async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await order.update({ status: 'delivered' });
    res.json({ success: true });
  } catch (err) {
    logger.error('Deliver order error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ── Redo order (duplicate as new active order) ────────────────────────────────
router.post('/api/orders/:id/redo', async (req, res) => {
  try {
    const original = await Order.findByPk(req.params.id);
    if (!original) return res.status(404).json({ error: 'Order not found' });
    const newOrder = await Order.create({
      user_id:      original.user_id,
      owner_name:   original.owner_name,
      company_name: original.company_name,
      email:        original.email,
      phone:        original.phone,
      location:     original.location,
      items:        original.items,
      qty:          original.qty,
      shipping:     original.shipping,
      total:        original.total,
      status:       'active',
      created_at:   new Date(),
    });
    res.json({ ok: true, id: newOrder.id });
  } catch (err) {
    logger.error('Redo order error:', err);
    res.status(500).json({ error: err.message });
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
