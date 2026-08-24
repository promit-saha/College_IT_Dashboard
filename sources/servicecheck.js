// Service uptime monitor.
// Reads the site list from services.txt (project root) on every refresh
// cycle, not just at startup, so sites can be added or removed by
// editing that file, no server restart needed.
//
// Method: HEAD first (cheaper), falls back to GET only on a clean 405
// (method not allowed) response, not on network errors, so a genuinely
// down site doesn't sit through two timeouts before being marked down.
//
// Status model:
//   up       - got an HTTP response, status under 500
//   degraded - got an HTTP response, but status 500 or above (server
//              reachable, but erroring)
//   down     - no response at all (timeout, DNS failure, connection
//              refused, TLS handshake failure)
//
// Known limitation, not solved here on purpose: a site with an expired
// or self-signed certificate will show as "down" (TLS handshake
// failure), even if the application behind it is actually fine. If that
// turns out to be true for a specific real site, that needs a specific
// fix for that one host, not a blanket "ignore all certificate errors"
// setting for every site being checked.

const fs = require('fs');
const path = require('path');
const cache = require('../cache');

const CACHE_KEY = 'services';
const REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
const SERVICES_FILE = path.join(__dirname, '..', 'services.txt');
const USER_AGENT = 'Demo-ICT-Dashboard-Uptime-Check/1.0';

function loadServiceList() {
  let raw;
  try {
    raw = fs.readFileSync(SERVICES_FILE, 'utf8');
  } catch (err) {
    console.error('[servicecheck] could not read services.txt:', err.message);
    return [];
  }

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [name, url] = line.split('|').map(s => s.trim());
      return name && url ? { name, url } : null;
    })
    .filter(Boolean);
}

async function checkService({ name, url }) {
  const start = Date.now();
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 405) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    }
    const ms = Date.now() - start;
    const status = res.status >= 500 ? 'degraded' : 'up';
    return { name, url, status, httpStatus: res.status, ms };
  } catch (err) {
    const ms = Date.now() - start;
    // fetch() wraps the real reason in err.cause (Node's undici), the
    // top-level message alone is usually just the generic "fetch failed".
    const detail = err.cause
      ? `${err.message}: ${err.cause.message || err.cause.code || err.cause}`
      : err.message;
    return { name, url, status: 'down', httpStatus: null, ms, error: detail };
  }
}

async function refresh() {
  try {
    const services = loadServiceList();
    if (!services.length) {
      cache.setError(CACHE_KEY, 'services.txt is empty or missing');
      return;
    }

    const results = await Promise.all(services.map(checkService));
    const down = results.filter(r => r.status === 'down').length;
    const degraded = results.filter(r => r.status === 'degraded').length;

    cache.set(CACHE_KEY, { services: results, down, degraded, total: results.length });
  } catch (err) {
    console.error('[servicecheck] refresh failed:', err.message);
    cache.setError(CACHE_KEY, err.message);
  }
}

function start() {
  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

module.exports = { start, refresh, loadServiceList, checkService, CACHE_KEY };
