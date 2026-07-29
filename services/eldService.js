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
  const vehicleGpsMap = {};
  try {
    const res = await client.get('/vehicles', { params: { limit: 1000 } });
    const raw = res.data?.data ?? res.data?.vehicles ?? res.data?.results ?? res.data;
    if (Array.isArray(raw)) {
      for (const v of raw) {
        const vid = String(v.vehicle_id ?? v.id ?? '');
        if (!vid) continue;
        if (v.number) unitNumberMap[vid] = v.number;
        // Capture last-known GPS from /vehicles if present
        if (v.lat ?? v.latitude ?? v.gps_lat ?? v.last_lat ?? v.last_latitude) {
          vehicleGpsMap[vid] = v;
        }
      }
    }
  } catch (err) {
    logger.warn('fetchVehicleStatus: /vehicles failed — ' + (err.response?.status || err.message));
  }

  // Build index of vehicles already covered by /latest-vehicle-status
  const gpsById = {};
  for (const v of gpsRecords) {
    const vid = String(v.vehicle_id ?? v.id ?? '');
    if (vid) gpsById[vid] = v;
  }

  // Add any vehicles from /vehicles that have GPS but aren't in /latest-vehicle-status
  for (const [vid, v] of Object.entries(vehicleGpsMap)) {
    if (!gpsById[vid]) {
      logger.info(`fetchVehicleStatus: supplementing GPS for vehicle ${vid} from /vehicles`);
      gpsById[vid] = v;
    }
  }

  return Object.values(gpsById).map(v => {
    const vid = String(v.vehicle_id ?? v.id ?? '');
    return vid && unitNumberMap[vid] ? { ...v, number: unitNumberMap[vid] } : v;
  });
}

async function fetchHosList(companyKey) {
  try {
    const headers = { 'X-API-Provider-Key': PROVIDER_KEY };
    if (companyKey) headers['X-API-Company-Key'] = companyKey;
    const client = axios.create({ baseURL: API_V1_BASE, headers, timeout: 15000 });
    const res = await client.get('/hos/list', { params: { limit: 1000 } });
    const drivers = res.data?.data?.drivers ?? [];
    return Array.isArray(drivers) ? drivers : [];
  } catch (err) {
    const status = err.response?.status;
    logger.warn('fetchHosList failed: ' + (status || err.message));
    return status === 401 ? null : [];
  }
}

// Factor ELD HOS list via Portal API (session token) — same endpoint but proper auth
async function fetchFactorHosList(sessionToken, tenantId) {
  const companyId = process.env.FACTOR_COMPANY_ID;
  const headers = {
    'Authorization': `Bearer ${sessionToken}`,
    'Tenant_id': tenantId,
    'Company_id': companyId ?? tenantId,
    'Accept': 'application/json',
  };

  // /hos/list — matches exactly what the Factor portal sends
  try {
    const res = await axios.get(`${API_V1_BASE}/hos/list`, {
      headers,
      timeout: 15000,
      params: {
        page: 1,
        limit: 1000,
        eld_status: 'all',
        duty_status: 'all',
        online_status: 'all',
        violation_status: 'all',
        driver_status: 'active',
        sort_by: 'default',
        sort_order: 'default',
      },
    });
    const drivers = res.data?.data?.drivers ?? res.data?.drivers ?? res.data?.data ?? [];
    if (Array.isArray(drivers) && drivers.length > 0) {
      logger.info(`fetchFactorHosList: /hos/list returned ${drivers.length} records`);
      return drivers;
    }
    logger.info(`fetchFactorHosList: /hos/list returned 0 — ${JSON.stringify(res.data ?? '').slice(0, 300)}`);
  } catch (err) {
    const status = err.response?.status;
    const body = JSON.stringify(err.response?.data ?? '').slice(0, 300);
    logger.warn(`fetchFactorHosList: /hos/list failed — ${status || err.message} — ${body}`);
  }

  // /drivers — fallback
  try {
    const res = await axios.get(`${API_V1_BASE}/drivers`, {
      headers,
      timeout: 15000,
      params: { limit: 1000, page: 1, status: 'all' },
    });
    const drivers = res.data?.data?.drivers ?? res.data?.drivers ?? res.data?.data ?? [];
    if (Array.isArray(drivers) && drivers.length > 0) {
      logger.info(`fetchFactorHosList: /drivers returned ${drivers.length} records`);
      return drivers;
    }
  } catch (err) {
    const status = err.response?.status;
    const body = JSON.stringify(err.response?.data ?? '').slice(0, 300);
    logger.warn(`fetchFactorHosList: /drivers failed — ${status || err.message} — ${body}`);
  }

  return [];
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

async function fetchFmcsaTransfers(sessionToken, tenantId) {
  const headers = {
    'Authorization': `Bearer ${sessionToken}`,
    'Tenant_id': tenantId,
    'Accept': 'application/json',
  };
  const candidates = [
    `${API_V1_BASE}/fmcsa?limit=200&page=1`,
    `${API_V1_BASE}/fmcsa/company?limit=200&page=1`,
  ];
  for (const url of candidates) {
    try {
      const res = await axios.get(url, { headers, timeout: 15000 });
      const logs = res.data?.data?.logs ?? res.data?.logs ?? [];
      if (Array.isArray(logs) && logs.length > 0) {
        logger.info(`fetchFmcsaTransfers: ${url} returned ${logs.length} records`);
        return logs;
      }
      logger.info(`fetchFmcsaTransfers: ${url} returned 0 records`);
    } catch (err) {
      logger.info(`fetchFmcsaTransfers: ${url} failed — ${err.response?.status || err.message}`);
    }
  }
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

module.exports = { fetchDrivers, fetchDriverStatus, fetchVehicleStatus, fetchHosList, fetchFactorHosList, fetchCompanyInfo, fetchInspections, fetchFmcsaTransfers, fetchDriverLogEvents, formatSeconds, reverseGeocode };
