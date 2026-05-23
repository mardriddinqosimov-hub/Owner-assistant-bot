const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = {
  info: (message) => {
    const timestamp = new Date().toISOString();
    console.log(`ℹ️  [${timestamp}] ${message}`);
    fs.appendFileSync(path.join(logsDir, 'combined.log'), `[${timestamp}] INFO: ${message}\n`);
  },
  error: (message, error = '') => {
    const timestamp = new Date().toISOString();
    console.error(`❌ [${timestamp}] ${message}`, error);
    fs.appendFileSync(path.join(logsDir, 'error.log'), `[${timestamp}] ERROR: ${message} ${error}\n`);
  },
  warn: (message) => {
    const timestamp = new Date().toISOString();
    console.warn(`⚠️  [${timestamp}] ${message}`);
    fs.appendFileSync(path.join(logsDir, 'combined.log'), `[${timestamp}] WARN: ${message}\n`);
  },
  debug: (message) => {
    if (process.env.LOG_LEVEL === 'debug') {
      const timestamp = new Date().toISOString();
      console.log(`🔍 [${timestamp}] ${message}`);
    }
  },
};

module.exports = logger;
