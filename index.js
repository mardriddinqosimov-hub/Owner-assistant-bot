require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf } = require('telegraf');
const logger = require('./utils/logger');
const database = require('./config/database');
const { Setting } = require('./models/Setting');
const Order = require('./models/Order');
const User = require('./models/User');
const commandHandlers = require('./handlers/commandHandlers');
const callbackHandlers = require('./handlers/callbackHandlers');
const messageHandlers = require('./handlers/messageHandlers');
const accountingHandlers    = require('./handlers/accountingHandlers');
const adminBotHandlers      = require('./handlers/adminBotHandlers');
const managementBotHandlers = require('./handlers/managementBotHandlers');
const groupHandlers = require('./handlers/groupHandlers');
const supportBotHandlers = require('./handlers/supportBotHandlers');
const notifService = require('./services/notificationService');
const menuTracker = require('./utils/menuTracker');
require('./models/SupportTask');   // ensure table is created on sync
require('./models/SupportMember'); // ensure table is created on sync
const dashboardModule = require('./routes/dashboard');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ORDER_GROUP_ID = process.env.ORDER_GROUP_ID || '-5129310180';
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID || '1125665706';

async function initDatabase() {
  try {
    await database.authenticate();
    logger.info('✅ Database connected');
    await database.sync({ alter: true });
    logger.info('✅ Database synced');
  } catch (error) {
    logger.warn('⚠️  Database not available - bot running without DB: ' + error.message);
  }
}

bot.use(async (ctx, next) => {
  try {
    ctx.session = ctx.session || {};
    // Block check (private chats only)
    if (ctx.chat?.type === 'private' && ctx.from?.id) {
      const u = await User.findOne({ where: { telegram_id: ctx.from.id } });
      if (u?.blocked) {
        return ctx.reply('⛔ Your access has been restricted. Contact admin.');
      }
      if (u && (!u.first_name || !u.username) && ctx.from.first_name) {
        await u.update({ first_name: ctx.from.first_name || u.first_name, last_name: ctx.from.last_name || u.last_name, username: ctx.from.username || u.username });
      }
    }
    await next();
  } catch (error) {
    logger.error('Middleware error:', error);
    ctx.reply('❌ Something went wrong. Please try again.');
  }
});

// ─── Menu always at bottom: delete old message, send fresh reply ─────────────
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery && ctx.chat?.type === 'private') {
    const originalEdit = ctx.editMessageText.bind(ctx);
    ctx.editMessageText = async (text, opts) => {
      try {
        await ctx.deleteMessage();
        const msg = await ctx.reply(text, opts);
        menuTracker.set(ctx.from.id, msg.message_id);
        return msg;
      } catch {
        return originalEdit(text, opts);
      }
    };
  }
  return next();
});

// ─── Main bot commands ────────────────────────────────────────────────────────
bot.start(commandHandlers.start);
bot.command('setapi', commandHandlers.setapi);

// ─── Driver callbacks ─────────────────────────────────────────────────────────
bot.action(/^driver_details_(.+)$/, callbackHandlers.driverDetails);
bot.action(/^driver_refresh_(.+)$/, callbackHandlers.driverRefresh);
bot.action(/^driver_location_(.+)$/, callbackHandlers.driverLocation);
bot.action('noop', ctx => ctx.answerCbQuery());
bot.action('drivers_list', callbackHandlers.driversList);
bot.action('drivers_list_refresh', callbackHandlers.driversListRefresh);
bot.action(/^drivers_cat_(D|ON|SB|OFF)$/, callbackHandlers.driversCatShow);
bot.action(/^drivers_catref_(D|ON|SB|OFF)$/, callbackHandlers.driversCatRefresh);

// ─── Order submenu ────────────────────────────────────────────────────────────
bot.action('order_devices_start', callbackHandlers.orderStart);
bot.action('order_new', callbackHandlers.orderNew);

// Full Set flow
bot.action('order_fullset', callbackHandlers.orderFullSet);
bot.action(/^fs_cable_(vm|obd|rp|p9)$/, callbackHandlers.fsSelectCable);
bot.action(/^fs_cnt_(\d+)$/, callbackHandlers.fsSelectCount);
bot.action(/^fs_shp_(s|o)$/, callbackHandlers.fsSelectShipping);

// Custom cart flow
bot.action('order_custom', callbackHandlers.orderCustom);
bot.action(/^cu_item_(pt30|vm|obd|rp|p9|stk)$/, callbackHandlers.cuSelectItem);
bot.action(/^cu_qty_(pt30|vm|obd|rp|p9|stk)_(\d+)$/, callbackHandlers.cuSetQty);
bot.action('cu_shipping', callbackHandlers.cuShowShipping);
bot.action(/^cu_ship_(s|o)$/, callbackHandlers.cuSelectShipping);

// Order management
bot.action('order_confirm', callbackHandlers.orderConfirm);
bot.action('order_edit', callbackHandlers.orderEdit);
bot.action('order_cancel', callbackHandlers.orderCancel);
bot.action('order_active', callbackHandlers.orderActive);
bot.action(/^order_history_(\d+)$/, callbackHandlers.orderHistory);
bot.action(/^order_detail_(\d+)$/, callbackHandlers.orderDetail);
bot.action(/^order_redo_(\d+)$/, callbackHandlers.orderRedo);

// ─── Special Task callbacks ───────────────────────────────────────────────────
bot.action('special_task_menu',    callbackHandlers.specialTaskMenu);
bot.action('special_task_message', callbackHandlers.specialTaskMessage);
bot.action('special_task_call',    callbackHandlers.specialTaskCall);
bot.action(/^task_call_ended_(\d+)$/, callbackHandlers.taskCallEnded);
bot.action(/^task_approved_(\d+)$/,   callbackHandlers.taskOwnerApproved);
bot.action(/^task_not_done_(\d+)$/,   callbackHandlers.taskNotDone);
bot.action('support_status',            callbackHandlers.supportStatus);
bot.action('support_cancel_session',    callbackHandlers.cancelSupportSession);
bot.action('support_request_history',   callbackHandlers.ownerRequestsHistory);

// ─── Referral ─────────────────────────────────────────────────────────────────
bot.action('referral_menu',                  callbackHandlers.referralMenu);
bot.action(/^referral_history_(\d+)$/,       callbackHandlers.referralHistory);
bot.action('referral_balance',               callbackHandlers.referralBalanceMenu);
bot.action('ref_withdraw_card',              callbackHandlers.refWithdrawCard);
bot.action('ref_cover_service',              callbackHandlers.refCoverService);

// ─── Platform selection ───────────────────────────────────────────────────────
bot.action(/^platform_select_(leader|factor)$/, callbackHandlers.selectPlatform);

// ─── DOT Inspection callbacks ─────────────────────────────────────────────────
bot.action('dot_menu', callbackHandlers.dotMenu);
bot.action(/^dot_detail_(\d+)$/, callbackHandlers.dotDetail);

// ─── Menu callbacks ───────────────────────────────────────────────────────────
bot.action('main_menu', callbackHandlers.mainMenu);
bot.action('change_team', callbackHandlers.changeTeam);
bot.action('help_menu', callbackHandlers.helpMenu);

// ─── Messages ─────────────────────────────────────────────────────────────────
bot.on('text', messageHandlers.handleText);
bot.on('photo', messageHandlers.handlePhoto);
bot.on('document', messageHandlers.handleDocument);
bot.on('voice', messageHandlers.handleVoice);

// ─── Group order listener ─────────────────────────────────────────────────────
bot.on('message', groupHandlers.handleGroupMessage);

// ─── Accounting bot ───────────────────────────────────────────────────────────
let accountingBot = null;

function setupAccountingBot() {
  if (!process.env.ACCOUNTING_BOT_TOKEN) {
    logger.warn('ACCOUNTING_BOT_TOKEN not set — accounting bot disabled');
    return;
  }

  accountingBot = new Telegraf(process.env.ACCOUNTING_BOT_TOKEN);

  // Allow the designated admin OR any user with accounting_admin role
  accountingBot.use(async (ctx, next) => {
    if (!ctx.from?.id) return;
    if (String(ctx.from.id) === String(ADMIN_ID)) return next();
    const u = await User.findOne({ where: { telegram_id: ctx.from.id } });
    if (u?.role === 'accounting_admin') return next();
    if (ctx.message || ctx.callbackQuery) {
      try { await ctx.reply('⛔ Access denied. This bot is for accounting admins only.'); } catch {}
    }
  });

  accountingBot.command('start', accountingHandlers.acctStart);
  accountingBot.command('track', accountingHandlers.acctTrack);
  accountingBot.command('deliver', accountingHandlers.acctDeliver);
  accountingBot.command('close', accountingHandlers.acctClose);
  accountingBot.command('open', accountingHandlers.acctOpen);
  accountingBot.command('status', accountingHandlers.acctStatus);

  // Main nav
  accountingBot.action('acct_main_menu', accountingHandlers.acctMainMenu);

  // Active orders
  accountingBot.action('acct_active_orders', accountingHandlers.acctActiveOrders);
  accountingBot.action(/^acct_order_(\d+)$/, accountingHandlers.acctOrderDetail);
  accountingBot.action(/^acct_add_track_(\d+)$/, accountingHandlers.acctAddTrackingStart);
  accountingBot.action(/^acct_deliver_cb_(\d+)$/, accountingHandlers.acctDeliverCb);

  // Order management
  accountingBot.action('acct_management', accountingHandlers.acctManagement);
  accountingBot.action('acct_close_prompt', accountingHandlers.acctClosePrompt);
  accountingBot.action('acct_close_default', accountingHandlers.acctCloseDefault);
  accountingBot.action('acct_open', accountingHandlers.acctOpenCb);
  accountingBot.action('acct_status', accountingHandlers.acctStatusCb);

  // Order history
  accountingBot.action('acct_history', accountingHandlers.acctHistory);
  accountingBot.action(/^acct_history_order_(\d+)$/, accountingHandlers.acctHistoryOrder);

  accountingBot.action('acct_referrals',              accountingHandlers.acctReferrals);
  accountingBot.action(/^acct_ref_detail_(\d+)$/,     accountingHandlers.acctReferralDetail);
  accountingBot.action(/^acct_ref_(card|credit)_(\d+)$/, accountingHandlers.acctRefPayout);
  accountingBot.on('text', accountingHandlers.acctHandleText);
}

// ─── Head Admin bot ──────────────────────────────────────────────────────────
let adminBot = null;

function setupAdminBot() {
  if (!process.env.HEAD_ADMIN_BOT_TOKEN) {
    logger.warn('HEAD_ADMIN_BOT_TOKEN not set — admin bot disabled');
    return;
  }

  adminBot = new Telegraf(process.env.HEAD_ADMIN_BOT_TOKEN);

  // Only the head admin can use this bot
  adminBot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== String(ADMIN_ID)) return;
    return next();
  });

  adminBot.command('start', adminBotHandlers.haStart);

  adminBot.action('ha_main',      adminBotHandlers.haMain);
  adminBot.action('ha_stats',     adminBotHandlers.haStats);
  adminBot.action('ha_broadcast', adminBotHandlers.haBroadcast);

  adminBot.action(/^ha_users_(\d+)$/,         (ctx) => adminBotHandlers.haUsers(ctx, parseInt(ctx.match[1])));
  adminBot.action(/^ha_user_(\d+)$/,           adminBotHandlers.haUserDetail);
  adminBot.action(/^ha_role_(\d+)_([\w]+)$/,  adminBotHandlers.haSetRole);
  adminBot.action(/^ha_block_(\d+)$/,          adminBotHandlers.haBlock);
  adminBot.action(/^ha_unblock_(\d+)$/,        adminBotHandlers.haUnblock);
  adminBot.action(/^ha_delete_(\d+)$/,         adminBotHandlers.haDeleteConfirm);
  adminBot.action(/^ha_delete_yes_(\d+)$/,     adminBotHandlers.haDeleteUser);
  adminBot.action(/^ha_bc_(all|owner|safety|leader|factor)$/, adminBotHandlers.haBcTarget);
  adminBot.action('ha_report',                               adminBotHandlers.haReport);
  adminBot.action(/^ha_report_(week|month|all)$/,            adminBotHandlers.haGenerateReport);

  // Admin users management
  adminBot.action('ha_admins',                               adminBotHandlers.haAdmins);
  adminBot.action(/^ha_admin_(\d+)$/,                        adminBotHandlers.haAdminDetail);
  adminBot.action('ha_admin_add',                            adminBotHandlers.haAdminAdd);
  adminBot.action(/^ha_admin_type_([\w]+)$/,                 adminBotHandlers.haAdminChooseType);
  adminBot.action(/^ha_admin_role_(\d+)_([\w]+)$/,           adminBotHandlers.haAdminSetRole);
  adminBot.action(/^ha_admin_remove_(\d+)$/,                 adminBotHandlers.haAdminRemove);

  adminBot.action('ha_blocks',                               adminBotHandlers.haBlocks);
  adminBot.action(/^ha_block_view_([\w]+)$/,                 adminBotHandlers.haBlockDetail);
  adminBot.action(/^ha_block_owners_([\w]+)$/,               adminBotHandlers.haBlockOwners);
  adminBot.action(/^ha_assign_block_(\d+)$/,                 adminBotHandlers.haAssignBlock);
  adminBot.action(/^ha_setblock_(\d+)_([\w]+)$/,             adminBotHandlers.haSetBlock);
  adminBot.action(/^ha_team_members_([\w]+)$/,               adminBotHandlers.haTeamMembers);
  adminBot.action(/^ha_member_add_([\w]+)$/,                 adminBotHandlers.haTeamMemberAdd);
  adminBot.action(/^ha_member_remove_confirm_(\d+)$/,        adminBotHandlers.haTeamMemberRemoveConfirm);
  adminBot.action(/^ha_member_remove_(\d+)$/,                adminBotHandlers.haTeamMemberRemove);

  adminBot.on('text', adminBotHandlers.haHandleText);
}

// ─── Management bot ──────────────────────────────────────────────────────────
let managementBot = null;

function setupManagementBot() {
  if (!process.env.MANAGEMENT_BOT_TOKEN) {
    logger.warn('MANAGEMENT_BOT_TOKEN not set — management bot disabled');
    return;
  }

  managementBot = new Telegraf(process.env.MANAGEMENT_BOT_TOKEN);

  managementBot.start(managementBotHandlers.mgmtStart);

  managementBot.action('mg_main',              managementBotHandlers.mgmtMain);
  managementBot.action('mg_pending',           managementBotHandlers.mgmtPending);
  managementBot.action(/^mg_all_(\d+)$/,       managementBotHandlers.mgmtAllReferrals);
  managementBot.action(/^mg_ref_(\d+)$/,       managementBotHandlers.mgmtRefDetail);
  managementBot.action(/^mg_confirm_(\d+)$/,   managementBotHandlers.mgmtConfirm);
  managementBot.action(/^mg_reject_(\d+)$/,    managementBotHandlers.mgmtReject);
  managementBot.action('mg_balances',          managementBotHandlers.mgmtBalances);

  managementBot.on('text', managementBotHandlers.mgmtHandleText);
}

// ─── Support bot ─────────────────────────────────────────────────────────────
let supportBot = null;

function setupSupportBot() {
  if (!process.env.SUPPORT_BOT_TOKEN) {
    logger.warn('SUPPORT_BOT_TOKEN not set — support bot disabled');
    return;
  }
  supportBot = new Telegraf(process.env.SUPPORT_BOT_TOKEN);
  supportBot.command('start', supportBotHandlers.supportStart);
  supportBot.command('chatid', supportBotHandlers.getChatId);
  supportBot.command('getid', supportBotHandlers.getTopicId);
  supportBot.action('noop', ctx => ctx.answerCbQuery());
  supportBot.action(/^sup_pick_(\d+)_(\d+)$/,  supportBotHandlers.supPickMember);
  supportBot.action(/^sup_switch_(\d+)$/,      supportBotHandlers.supSwitchMember);
  supportBot.action(/^sup_done_(\d+)$/,        supportBotHandlers.supDone);
supportBot.on('message', supportBotHandlers.handleSupportTopicMessage); // support topics
}

// ─── GPS vehicle polling (every 30 sec) ───────────────────────────────────────
// DriveHOS only returns 1 vehicle at a time (the most recently updated).
// By polling frequently we catch each truck as it checks in and cache the data.
function startGpsPolling() {
  const { fetchVehicleStatus } = require('./services/eldService');
  const Driver = require('./models/Driver');

  const run = async () => {
    try {
      const users = await User.findAll({ where: { company_api_key: { [require('sequelize').Op.ne]: null } } });
      for (const user of users) {
        try {
          const vehicleRaw = await fetchVehicleStatus(user.company_api_key);
          for (const v of vehicleRaw) {
            if (!v.driver_id) continue;
            const driver = await Driver.findOne({ where: { driver_id: String(v.driver_id), user_id: user.id } });
            if (!driver) continue;
            const rawLat = v.lat ?? v.latitude;
            const rawLon = v.lon ?? v.longitude;
            await driver.update({
              speed:           v.speed ?? null,
              latitude:        rawLat ? parseFloat(rawLat) : null,
              longitude:       rawLon ? parseFloat(rawLon) : null,
              truck_number:    v.number || null,
              location_string: v.calc_location || null,
            });
          }
        } catch {}
      }
    } catch (e) {
      logger.warn('GPS poll error:', e.message);
    }
  };

  setInterval(run, 30 * 1000);
  logger.info('✅ GPS vehicle polling started (30 sec interval)');
}

// ─── DOT inspection polling (every 10 min) ────────────────────────────────────
function startInspectionPolling() {
  const INTERVAL = 10 * 60 * 1000;
  const run = () => commandHandlers.checkNewInspections(bot).catch(e => logger.warn('Inspection poll error:', e.message));
  setInterval(run, INTERVAL);
  logger.info('✅ DOT inspection polling started (10 min interval)');
}

async function startBot() {
  try {
    await initDatabase();
    setupAccountingBot();
    setupAdminBot();
    setupManagementBot();
    setupSupportBot();

    // Wire notification service
    notifService.setMainBot(bot);
    if (accountingBot)  notifService.setAccountingBot(accountingBot);
    if (adminBot)       notifService.setAdminBot(adminBot);
    if (managementBot)  notifService.setManagementBot(managementBot);
    if (supportBot)     notifService.setSupportBot(supportBot);

    // ─── Express (always runs — serves dashboard + health + optional webhook) ──
    const app = express();
    const PORT = process.env.PORT || 3000;

    if (process.env.NODE_ENV === 'production' && process.env.WEBHOOK_URL) {
      const webhookPath = '/telegram';
      const webhookUrl = `${process.env.WEBHOOK_URL}${webhookPath}`;
      // Webhook callback must be registered before body parsers
      app.use(bot.webhookCallback(webhookPath));
      await bot.telegram.setWebhook(webhookUrl);
      logger.info(`✅ Webhook set: ${webhookUrl}`);
    } else {
      await bot.telegram.deleteWebhook();
      bot.launch();
      logger.info('✅ Main bot polling started');
    }

    // Dashboard (wire bot reference for payment proxy)
    dashboardModule.setBot(bot);
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/admin', dashboardModule.router);
    app.get('/health', (req, res) => res.json({ status: 'ok' }));

    app.listen(PORT, () => logger.info(`✅ Server listening on port ${PORT} — dashboard at /admin`));

    // Accounting bot always uses polling (internal tool)
    if (accountingBot) {
      await accountingBot.telegram.deleteWebhook();
      accountingBot.launch();
      logger.info('✅ Accounting bot polling started');
    }

    // Admin bot
    if (adminBot) {
      await adminBot.telegram.deleteWebhook();
      adminBot.launch();
      logger.info('✅ Head admin bot polling started');
    }

    // Management bot
    if (managementBot) {
      await managementBot.telegram.deleteWebhook();
      managementBot.launch();
      logger.info('✅ Management bot polling started');
    }

    // Support bot
    if (supportBot) {
      await supportBot.telegram.deleteWebhook();
      supportBot.launch();
      logger.info('✅ Support bot polling started');
    }

    startInspectionPolling();
    startGpsPolling();
    logger.info('🤖 BOT ONLINE - READY FOR COMMANDS');
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  if (accountingBot)  accountingBot.stop('SIGINT');
  if (adminBot)       adminBot.stop('SIGINT');
  if (managementBot)  managementBot.stop('SIGINT');
  if (supportBot)     supportBot.stop('SIGINT');
  process.exit(0);
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  if (accountingBot)  accountingBot.stop('SIGTERM');
  if (adminBot)       adminBot.stop('SIGTERM');
  if (managementBot)  managementBot.stop('SIGTERM');
  if (supportBot)     supportBot.stop('SIGTERM');
  process.exit(0);
});

startBot();
module.exports = bot;
