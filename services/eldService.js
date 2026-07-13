const axios = require('axios');
const logger = require('../utils/logger');

const PARTNER_BASE = 'https://api.drivehos.app/v2';
const API_V1_BASE = 'https://api.drivehos.app/api/v1';
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

  let gpsRecords = [];
  try {
    const res = await client.get('/latest-vehicle-status', { params: { limit: 1000 } });
    const raw = res.data?.data ?? res.data?.vehicles ?? res.data?.results ?? res.data;
    if (Array.isArray(raw) && raw.length > 0) gpsRecords = raw;
  } catch (err) {
    logger.warn('fetchVehicleStatus: /latest-vehicle-status failed — ' + (err.response?.status || err.message));
  }

  const unitNumberMap = {};
  try {
    const res = await client.get('/vehicles', { params: { limit: 1000 } });
    const raw = res.data?.data ?? res.data?.vehicles ?? res.data?.results ?? res.data;
    if (Array.isArray(raw)) {
      for (const v of raw) {
        const vid = String(v.vehicle_id ?? v.id ?? '');
        if (vid && v.number) unitNumberMap[vid] = v.number;
      }
    }
  } catch (err) {
    logger.warn('fetchVehicleStatus: /vehicles failed — ' + (err.response?.status || err.message));
  }

  return gpsRecords.map(v => {
    const vid = String(v.vehicle_id ?? v.id ?? '');
    return vid && unitNumberMap[vid] ? { ...v, number: unitNumberMap[vid] } : v;
  });
}

// Fetches the HOS list from the portal API — includes lat, lon, calculated_location,
// vehicle_number, current_status, and HOS values in milliseconds.
async function fetchHosList(companyKey) {
  try {
    const headers = { 'X-API-Provider-Key': PROVIDER_KEY };
    if (companyKey) headers['X-API-Company-Key'] = companyKey;
    const client = axios.create({ baseURL: API_V1_BASE, headers, timeout: 15000 });
    const res = await client.get('/hos/list', { params: { limit: 1000, driver_status: 'active' } });
    const drivers = res.data?.data?.drivers ?? [];
    return Array.isArray(drivers) ? drivers : [];
  } catch (err) {
    logger.warn('fetchHosList failed: ' + (err.response?.status || err.message));
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

async function fetchInspections(companyKey) {
  const client = makeClient(companyKey);
  const candidates = [
    '/dot-inspections',
    '/inspections',
    '/roadside-inspections',
    '/dot-events',
    '/log-transfers',
    '/fmcsa-transfers',
    '/driver-inspections',
  ];
  for (const url of candidates) {
    try {
      const res = await client.get(url, { params: { limit: 200 } });
      const raw = res.data;
      const data = raw?.data ?? raw?.inspections ?? raw?.results ?? raw?.transfers ?? raw;
      if (Array.isArray(data) && data.length > 0) {
        logger.info(`fetchInspections: ${url} returned ${data.length} records`);
        return data;
      }
    } catch (err) {
      logger.info(`fetchInspections: ${url} failed — ${err.response?.status || err.message}`);
    }
  }
  logger.warn('fetchInspections: all endpoints returned empty');
  return [];
}

async function fetchDriverLogEvents(companyKey, daysBack = 2) {
  const client = makeClient(companyKey);
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  const fromStr = from.toISOString().split('T')[0];
  try {
    let data = [];
    for (const endpoint of ['/driver-logs', '/eld-events', '/driver-events', '/log-events']) {
      try {
        const res = await client.get(endpoint, { params: { limit: 500, from_date: fromStr } });
        const raw = res.data?.data ?? res.data?.results ?? res.data;
        if (Array.isArray(raw) && raw.length > 0) {
          data = raw;
          break;
        }
      } catch {}
    }
    return data;
  } catch (err) {
    logger.warn('fetchDriverLogEvents failed:', err.message);
    return [];
  }
}

module.exports = { fetchDrivers, fetchDriverStatus, fetchVehicleStatus, fetchHosList, fetchCompanyInfo, fetchInspections, fetchDriverLogEvents, formatSeconds, reverseGeocode };
