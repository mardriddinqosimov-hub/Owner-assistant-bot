const axios = require('axios');
const logger = require('../utils/logger');

const PARTNER_BASE = 'https://api.drivehos.app/v2';
const PROVIDER_KEY = process.env.PROVIDER_KEY;

function makeClient(companyKey) {
  const headers = { 'X-API-Provider-Key': PROVIDER_KEY };
  if (companyKey) headers['X-API-Company-Key'] = companyKey;
  return axios.create({ baseURL: PARTNER_BASE, headers, timeout: 15000 });
}

async function fetchDrivers(companyKey) {
  const client = makeClient(companyKey);
  try {
    const res = await client.get('/drivers', { params: { limit: 1000 } });
    const data = res.data?.data;
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const msg = err.response?.data?.description || err.message;
    logger.error('fetchDrivers failed:', msg);
    throw new Error(msg);
  }
}

async function fetchDriverStatus(companyKey) {
  const client = makeClient(companyKey);
  try {
    const res = await client.get('/latest-driver-status', { params: { limit: 1000 } });
    const data = res.data?.data;
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('fetchDriverStatus failed:', err.response?.data?.description || err.message);
    return [];
  }
}

async function fetchVehicleStatus(companyKey) {
  const client = makeClient(companyKey);
  try {
    const res = await client.get('/latest-vehicle-status', { params: { limit: 1000 } });
    const data = res.data?.data;
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('fetchVehicleStatus failed:', err.response?.data?.description || err.message);
    return [];
  }
}

async function fetchCompanyInfo(companyKey) {
  const client = makeClient(companyKey);
  try {
    const res = await client.get('/company-info');
    return res.data?.data || null;
  } catch (err) {
    logger.warn('fetchCompanyInfo failed:', err.response?.data?.description || err.message);
    return null;
  }
}

// H:MM format (e.g. 10:58, 68:59)
function formatSeconds(sec) {
  if (sec == null || sec < 0) return 'N/A';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon, format: 'json' },
      headers: { 'User-Agent': 'OwnerAssistantBot/1.0' },
      timeout: 5000,
    });
    const addr = res.data?.address;
    if (!addr) return null;
    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county;
    const state = addr.state;
    return city && state ? `${city}, ${state}` : null;
  } catch {
    return null;
  }
}

module.exports = { fetchDrivers, fetchDriverStatus, fetchVehicleStatus, fetchCompanyInfo, formatSeconds, reverseGeocode };
