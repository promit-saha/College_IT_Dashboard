// FortiAnalyzer source module.
// Uses username+password session login. Request shapes below follow
// Fortinet's own official technical tips (community.fortinet.com),
// specifically the LogView/logsearch article, not third-party docs.
//
// Key correction from earlier attempts: extra parameters (filter,
// logtype, time-range, etc.) go as DIRECT SIBLINGS of "url" inside
// params[0], not nested in a "data" sub-object. That mistake was the
// root cause of the persistent -32600 "Invalid Request" errors.
//
// NOTE: FortiView widgets (Applications, Sources) in this GUI actually
// render through a private internal endpoint (/p/fortiview/all/run/ajax/)
// tied to browser session + CSRF, not /jsonrpc at all, confirmed by
// inspecting the browser's own Network tab. They may or may not work via
// the public API even with this corrected structure. LogView (this
// module's main focus) is confirmed via official Fortinet docs to work
// through the standard /jsonrpc API.

const { Agent } = require('undici');
const cache = require('../cache');
const { resolveCountry } = require('./country-centroids');

const CACHE_KEY = 'fortianalyzer';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const ADOM = 'root';

const FAZ_HOST = process.env.FAZ_HOST;
const FAZ_USERNAME = process.env.FAZ_USERNAME;
const FAZ_PASSWORD = process.env.FAZ_PASSWORD;

// Fixed pin for the Threat Map's "source" side. Every internal request
// shows up as srccountry "Reserved" in FortiGate's own logs (private IPs
// have no real GeoIP location), so there's nothing to geolocate per
// event, the map always draws arcs FROM this one fixed point instead.
// Defaults to the North Campus; override via env vars if the primary
// display device sits at a different site.
const MAP_SOURCE_LAT = Number(process.env.FAZ_MAP_SOURCE_LAT) || -32.13;
const MAP_SOURCE_LON = Number(process.env.FAZ_MAP_SOURCE_LON) || 115.95;
const MAP_SOURCE_LABEL = process.env.FAZ_MAP_SOURCE_LABEL || "World's Greatest School";

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

let cachedSession = null;

async function login() {
  const res = await fetch(`https://${FAZ_HOST}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'exec',
      params: [{ data: { user: FAZ_USERNAME, passwd: FAZ_PASSWORD }, url: '/sys/login/user' }],
      id: 1
    }),
    dispatcher: insecureAgent
  });

  if (!res.ok) {
    throw new Error(`FortiAnalyzer login HTTP error ${res.status}`);
  }

  const json = await res.json();
  const result = Array.isArray(json.result) ? json.result[0] : json.result;

  if (!result || !result.status || result.status.code !== 0) {
    throw new Error(`FortiAnalyzer login failed: ${JSON.stringify(result && result.status)}`);
  }

  return json.session;
}

async function getSession(forceNew = false) {
  if (!cachedSession || forceNew) {
    cachedSession = await login();
  }
  return cachedSession;
}

async function logout() {
  if (!cachedSession) return;
  const session = cachedSession;
  cachedSession = null;
  try {
    await fetch(`https://${FAZ_HOST}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'exec',
        params: [{ url: '/sys/logout' }],
        session,
        id: 1
      }),
      dispatcher: insecureAgent
    });
  } catch (err) {
    console.error('[fortianalyzer] logout failed:', err.message);
  }
}

// extraParams are merged as direct siblings of "url" inside params[0],
// matching Fortinet's own documented examples, NOT nested in "data".
async function fazFetch(method, url, extraParams = null, allowRetry = true) {
  const session = await getSession();
  const body = {
    jsonrpc: '2.0',
    method,
    params: [{ url, ...(extraParams || {}) }],
    session,
    id: 1
  };

  const res = await fetch(`https://${FAZ_HOST}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    dispatcher: insecureAgent
  });

  if (!res.ok) {
    throw new Error(`FortiAnalyzer HTTP error ${res.status}`);
  }

  const json = await res.json();

  if (json.error) {
    throw new Error(`FortiAnalyzer JSON-RPC error at ${url}: ${JSON.stringify(json.error)}`);
  }

  const result = Array.isArray(json.result) ? json.result[0] : json.result;

  if (!result) {
    throw new Error(`FortiAnalyzer API error at ${url}: empty result`);
  }

  // Some responses (e.g. creating a log search task) legitimately don't
  // include a status field at all, that's success, not an error. Only
  // reject when status IS present and its code is non-zero.
  if (result.status && result.status.code !== 0) {
    if (allowRetry) {
      cachedSession = null;
      return fazFetch(method, url, extraParams, false);
    }
    throw new Error(`FortiAnalyzer API error at ${url}: ${JSON.stringify(result.status)}`);
  }

  return result;
}

function timeRangeLast(hours) {
  // Relative time range, avoids all timezone conversion entirely
  // (confirmed as a valid format in Fortinet's own documentation).
  return { 'last-n-hours': hours };
}

async function deleteTask(url) {
  try {
    await fazFetch('delete', url, { apiver: 3 }, false);
  } catch (err) {
    // Best effort, a task that's already gone (or fails to delete) isn't
    // worth failing the whole refresh over.
    console.error('[fortianalyzer] task cleanup failed:', err.message);
  }
}

// ---- Generic log search: create task, then poll for results.
// Occasionally a task goes invalid right after creation for no
// consistent reason (confirmed: same search succeeds moments later on a
// fresh attempt). Rather than chase that further, retry the whole
// search a couple of times before giving up. ----
async function searchLogs(logtype, filterExpr, hours = 24, limit = 200, attemptsLeft = 2) {
  try {
    const submitResult = await fazFetch('add', `/logview/adom/${ADOM}/logsearch`, {
      apiver: 3,
      'case-sensitive': false,
      device: [{ devid: 'All_Devices' }],
      filter: filterExpr,
      logtype,
      'time-order': 'desc',
      'time-range': timeRangeLast(hours)
    });

    const tid = submitResult.tid;
    if (!tid) {
      throw new Error(`No task id returned for ${logtype} search`);
    }
    const taskUrl = `/logview/adom/${ADOM}/logsearch/${tid}`;

    await new Promise(resolve => setTimeout(resolve, 1500));

    let dataResult = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      dataResult = await fazFetch('get', taskUrl, {
        apiver: 3,
        limit,
        offset: 0
      }, false);
      if (dataResult.percentage === 100) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    await deleteTask(taskUrl);
    return (dataResult && dataResult.data) || [];
  } catch (err) {
    if (attemptsLeft > 0) {
      console.error(`[fortianalyzer] ${logtype} search failed (${err.message}), retrying...`);
      return searchLogs(logtype, filterExpr, hours, limit, attemptsLeft - 1);
    }
    throw err;
  }
}

async function fetchWebfilterLogs(filterExpr, hours = 24) {
  return searchLogs('webfilter', filterExpr, hours);
}

async function fetchTrafficLogs(hours = 24, limit = 500) {
  return searchLogs('traffic', '', hours, limit);
}

function describeHost(log) {
  if (log.srcname) return log.srcname;
  if (log.user) return log.user;
  if (log.osname) return log.devtype ? `${log.osname} ${log.devtype}` : log.osname;
  if (log.devtype) return log.devtype;
  return '';
}

function summarizeTopSources(trafficLogs, limit = 10) {
  const tally = {};
  for (const log of trafficLogs) {
    // Aggregate by MAC (confirmed present on real traffic logs via
    // /api/debug/faz-logsearch), not IP. DHCP can hand a device a new IP
    // mid-day, which would otherwise split one person's traffic across
    // two separate rows and understate who's actually using the most
    // bandwidth. Falls back to srcip only for traffic with no MAC (e.g.
    // the firewall's own local/self-originated traffic).
    const key = log.srcmac || log.srcip || 'Unknown';
    const bytes = (parseInt(log.sentbyte, 10) || 0) + (parseInt(log.rcvdbyte, 10) || 0);
    if (!tally[key]) tally[key] = { bytes: 0, sessions: 0, hostname: describeHost(log), srcip: log.srcip || '' };
    if (!tally[key].hostname) tally[key].hostname = describeHost(log);
    tally[key].bytes += bytes;
    tally[key].sessions += 1;
    // Keep the most recently seen IP for that device, useful as a
    // reference even though it's no longer the aggregation key.
    if (log.srcip) tally[key].srcip = log.srcip;
  }
  return Object.entries(tally)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, limit)
    .map(([, info]) => ({ srcip: info.srcip, bytes: info.bytes, sessions: info.sessions, hostname: info.hostname }));
}

// NOTE: despite the function name (kept for now to avoid touching every
// call site), this is NOT ips-specific. Confirmed via /api/debug/faz-alerts-raw
// against the real API: (1) the array comes back under "data", not
// "data.alerts", the old code's data.alerts was always undefined, always
// falling back to []. (2) none of the real alerts here have
// eventtype="ips" at all, they're "ssl", "app-ctrl", "webfilter", so that
// filter was excluding every alert that actually exists on this network.
async function fetchIpsAlerts(hours = 24) {
  const data = await fazFetch('get', `/eventmgmt/adom/${ADOM}/alerts`, {
    apiver: 3,
    limit: 100,
    offset: 0,
    'time-range': timeRangeLast(hours)
  });
  return data.data || [];
}

// Diagnostic only: same endpoint fetchIpsAlerts uses, but with no filter
// at all and the full raw response returned (not just .alerts), so we
// can see the actual shape/field names instead of assuming
// fetchIpsAlerts's existing filter and field names are correct.
async function debugAlertsRaw(hours = 24) {
  return fazFetch('get', `/eventmgmt/adom/${ADOM}/alerts`, {
    apiver: 3,
    limit: 100,
    offset: 0,
    'time-range': timeRangeLast(hours)
  });
}

// Threat Map events, built from the same blocked-webfilter-log fetch
// already used for "Blocked URL categories", no extra API call needed.
// srccountry is always "Reserved" (private IPs have no GeoIP location),
// so only dstcountry is geolocated, the source pin is the fixed campus
// location (MAP_SOURCE_*) instead. dstcountry/catdesc come back
// URL-encoded from the API (e.g. "United%20States"), decoded here.
function buildThreatMapEvents(blockedLogs, limit = 30) {
  const events = blockedLogs
    .map(log => {
      let country = null;
      try {
        country = log.dstcountry ? decodeURIComponent(log.dstcountry) : null;
      } catch {
        country = log.dstcountry || null;
      }
      let category = 'Other';
      try {
        category = log.catdesc ? decodeURIComponent(log.catdesc) : 'Other';
      } catch {
        category = log.catdesc || 'Other';
      }
      const info = resolveCountry(country);
      return {
        dateLabel: log.date && log.time ? `${log.date} ${log.time}` : null,
        category,
        srcip: log.srcip || '',
        dstip: log.dstip || '',
        country,
        countryCode: info ? info.cca2 : null,
        lat: info ? info.lat : null,
        lon: info ? info.lon : null
      };
    })
    .filter(e => e.dateLabel !== null)
    .sort((a, b) => (a.dateLabel < b.dateLabel ? 1 : a.dateLabel > b.dateLabel ? -1 : 0))
    .slice(0, limit);

  // One arc per destination country actually seen, not one per event,
  // otherwise a single chatty destination draws dozens of overlapping
  // arcs. Count reflects how many blocked hits that country had.
  const arcTally = {};
  for (const e of events) {
    if (!e.country || e.lat === null) continue;
    if (!arcTally[e.country]) {
      arcTally[e.country] = { country: e.country, lat: e.lat, lon: e.lon, count: 0 };
    }
    arcTally[e.country].count++;
  }
  const arcs = Object.values(arcTally).sort((a, b) => b.count - a.count);

  return { events, arcs };
}

async function fetchDevices() {
  return fazFetch('get', `/dvmdb/adom/${ADOM}/device`);
}

async function debugLogSearch(logtype = 'webfilter', filterExpr = '', devid = 'All_Devices', hours = 24) {
  const range = timeRangeLast(hours);
  const submitResult = await fazFetch('add', `/logview/adom/${ADOM}/logsearch`, {
    apiver: 3,
    'case-sensitive': false,
    device: [{ devid }],
    filter: filterExpr,
    logtype,
    'time-order': 'desc',
    'time-range': range
  });

  const tid = submitResult.tid;
  const pollHistory = [];

  await new Promise(resolve => setTimeout(resolve, 1500));

  for (let attempt = 0; attempt < 10; attempt++) {
    const dataResult = await fazFetch('get', `/logview/adom/${ADOM}/logsearch/${tid}`, {
      apiver: 3,
      limit: 5,
      offset: 0
    }, false);
    pollHistory.push({
      attempt,
      percentage: dataResult.percentage,
      scannedLogs: dataResult['scanned-logs'],
      totalCount: dataResult['total-count'],
      status: dataResult.status
    });
    if (dataResult.percentage === 100) {
      return { logtype, devid, hours, timeRangeUsed: range, submitResult, pollHistory, finalResult: dataResult };
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return { logtype, devid, hours, timeRangeUsed: range, submitResult, pollHistory, note: 'Never reached 100% after 10 polls' };
}

async function debugAll() {
  const checks = {
    webfilterLogs: () => fetchWebfilterLogs('', 24),
    trafficLogs: () => fetchTrafficLogs(24, 200),
    ipsAlerts: () => fetchIpsAlerts(24)
  };

  const results = {};
  for (const [name, fn] of Object.entries(checks)) {
    try {
      const data = await fn();
      results[name] = { ok: true, count: Array.isArray(data) ? data.length : null };
    } catch (err) {
      results[name] = { ok: false, error: err.message };
    }
  }
  return results;
}

async function refresh() {
  try {
    const [allWebfilterLogs, blockedLogs, trafficLogs, ipsAlerts] = await Promise.all([
      fetchWebfilterLogs('', 24),
      fetchWebfilterLogs('action=blocked', 24),
      fetchTrafficLogs(24, 500),
      fetchIpsAlerts(24).catch(() => [])
    ]);

    const sources = summarizeTopSources(trafficLogs, 10);

    const sourceTable = sources.slice(0, 4).map(s => ({
      host: s.hostname || 'Unknown',
      srcip: s.srcip,
      sessions: s.sessions,
      bytes: s.bytes
    }));

    const categoryTally = {};
    for (const log of allWebfilterLogs) {
      const cat = log.catdesc || 'Other';
      categoryTally[cat] = (categoryTally[cat] || 0) + 1;
    }
    const totalCatCount = allWebfilterLogs.length;
    const urlCategories = Object.entries(categoryTally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({
        name,
        percent: totalCatCount ? Math.round((count / totalCatCount) * 100) : 0
      }));

    const blockedTally = {};
    for (const log of blockedLogs) {
      const cat = log.catdesc || 'Other';
      blockedTally[cat] = (blockedTally[cat] || 0) + 1;
    }
    const blockedCategories = Object.entries(blockedTally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({ name, sessions: count, hits: count }));

    // Every severity now, not just critical/high. Field names below
    // (subject, alerttime, logcount, devname, epname, epip, dstepip,
    // alert_part_info.rulename, triggername) are taken straight from the
    // real response checked via /api/debug/faz-alerts-raw, not guessed.
    // alerttime is Unix epoch seconds, converted to epoch ms here.
    // rulename (e.g. "Insecure SSL Connection blocked") is the
    // human-readable rule name, nested under alert_part_info, falls back
    // to the more technical top-level triggername if that's missing.
    const mappedAlerts = ipsAlerts.map(a => ({
      message: (a.subject || 'Unknown alert') + (a.logcount && Number(a.logcount) > 1 ? ` (x${a.logcount})` : ''),
      severity: (a.severity || 'info').toLowerCase(),
      timestamp: a.alerttime ? Number(a.alerttime) * 1000 : null,
      devname: a.devname || '',
      epname: a.epname || '',
      epip: a.epip || '',
      dstepip: a.dstepip || '',
      rule: (a.alert_part_info && a.alert_part_info.rulename) || a.triggername || ''
    }));

    // Medium/high/critical always shown, uncapped (up to a generous
    // safety limit), so a burst of low-severity noise (there's a lot of
    // routine "low" SSL cert warnings on this network) can never push a
    // genuinely higher-priority alert out of view. Low/info only fill
    // whatever table space is left over, for context.
    const byRecency = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);
    const priorityAlerts = mappedAlerts
      .filter(a => ['critical', 'high', 'medium'].includes(a.severity))
      .sort(byRecency)
      .slice(0, 50);
    const otherAlerts = mappedAlerts
      .filter(a => !['critical', 'high', 'medium'].includes(a.severity))
      .sort(byRecency);
    const alerts = priorityAlerts.concat(otherAlerts.slice(0, Math.max(0, 40 - priorityAlerts.length)));

    const threatMap = {
      ...buildThreatMapEvents(blockedLogs, 30),
      source: { lat: MAP_SOURCE_LAT, lon: MAP_SOURCE_LON, label: MAP_SOURCE_LABEL }
    };

    cache.set(CACHE_KEY, {
      sourceTable,
      urlCategories,
      blockedCategories,
      alerts,
      threatMap
    });
  } catch (err) {
    console.error('[fortianalyzer] refresh failed:', err.message);
    cache.setError(CACHE_KEY, err.message);
  }
}

function start() {
  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

module.exports = { start, refresh, fetchDevices, debugAll, debugLogSearch, debugAlertsRaw, logout, CACHE_KEY };
