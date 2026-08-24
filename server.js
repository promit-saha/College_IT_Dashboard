require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cache = require('./cache');
const auth = require('./auth');
const DEMO_MODE = String(process.env.DEMO_MODE).toLowerCase() === 'true';

// So a fresh clone works immediately with zero configuration, a real
// deployment should still set its own DASHBOARD_PASSWORD in .env, this
// default only fills in if that's genuinely missing, and only in demo
// mode, never as a fallback for a real deployment.
if (DEMO_MODE && !process.env.DASHBOARD_PASSWORD) {
  process.env.DASHBOARD_PASSWORD = 'demo1234';
  console.log('[demo] No DASHBOARD_PASSWORD set, using default demo password: demo1234');
}

// In demo mode, none of the real source modules are ever required at
// all, they need real credentials just to load their config, so this
// avoids needing any of that to even start the server.
const halo = DEMO_MODE ? null : require('./sources/halo');
const observium = DEMO_MODE ? null : require('./sources/observium');
const fortigate = DEMO_MODE ? null : require('./sources/fortigate');
const fortianalyzer = DEMO_MODE ? null : require('./sources/fortianalyzer');
const darktrace = DEMO_MODE ? null : require('./sources/darktrace');
const servicecheck = DEMO_MODE ? null : require('./sources/servicecheck');
const demoRunner = DEMO_MODE ? require('./sources/demo-runner') : null;

const app = express();
const PORT = process.env.PORT || 4000;

// Only let the dashboard's own origin (or network) call this.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// ---- Auth gate: everything below this needs a valid session, except
// the login page itself and the login endpoint. API calls without a
// session get a 401, browser page loads get sent to the login page. ----
app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/api/login' || req.path === '/api/health') return next();

  const cookies = auth.parseCookies(req.headers.cookie);
  const token = cookies[auth.COOKIE_NAME];

  if (auth.isValidSession(token)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  return res.redirect('/login.html');
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!auth.checkPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = auth.createSession();
  res.cookie(auth.COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: auth.MAX_AGE_MS,
    sameSite: 'lax'
    // No `secure: true` here on purpose, this is served over plain HTTP
    // on the internal network, not HTTPS. If this ever moves behind
    // HTTPS, that should be turned on.
  });
  res.json({ ok: true });
});

// ---- Serve the dashboard itself ----
// Anything in public/ is served directly, public/index.html loads at "/"
app.use(express.static(path.join(__dirname, 'public')));

// ---- Health check: shows every source's status at a glance ----
app.get('/api/health', (req, res) => {
  const all = cache.getAll();
  const summary = Object.entries(all).map(([key, v]) => ({
    source: key,
    ok: v.ok,
    updatedAt: v.updatedAt,
    error: v.error || null
  }));
  res.json({ status: 'running', sources: summary });
});

// ---- Halo debug endpoint, hit this after setup to check field names ----
// In demo mode, every real source module is null, and none of these
// debug routes have anything real to call. One catch-all here instead
// of guarding all fourteen of them individually. In real mode this just
// calls next() and falls through to the actual routes below,
// completely unaffected.
app.get('/api/debug/*', (req, res, next) => {
  if (DEMO_MODE) {
    return res.status(404).json({ error: 'Debug routes are disabled in demo mode, there is no real API behind them to inspect.' });
  }
  next();
});

app.get('/api/debug/halo-sample', async (req, res) => {
  try {
    res.json(await halo.fetchSampleTicket());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Halo debug endpoint for the Agent list, to find id -> name mapping ----
app.get('/api/debug/halo-agents', async (req, res) => {
  try {
    res.json(await halo.fetchAgents());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Halo debug endpoint: raw open-ticket data, exact same query
// production refresh() uses, to check why some closed tickets are
// still showing up (looking for the real status field/value) ----
app.get('/api/debug/halo-open-raw', async (req, res) => {
  try {
    res.json(await halo.fetchOpenTicketsRawSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Halo debug endpoint for Ticket Types, to find the Incident id ----
app.get('/api/debug/halo-tickettypes', async (req, res) => {
  try {
    res.json(await halo.fetchTicketTypes());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- FortiAnalyzer debug endpoint: confirms auth and lists devices ----
app.get('/api/debug/faz-devices', async (req, res) => {
  try {
    res.json(await fortianalyzer.fetchDevices());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- FortiAnalyzer debug endpoint: tests the corrected log search
// structure end to end, showing both the submit and data-fetch steps ----
app.get('/api/debug/faz-logsearch', async (req, res) => {
  try {
    const logtype = req.query.logtype || 'webfilter';
    const filter = req.query.filter || '';
    const devid = req.query.devid || 'All_Devices';
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    res.json(await fortianalyzer.debugLogSearch(logtype, filter, devid, hours));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- FortiAnalyzer debug endpoint: tests all 4 calls independently ----
app.get('/api/debug/faz-all', async (req, res) => {
  try {
    res.json(await fortianalyzer.debugAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- FortiAnalyzer debug endpoint: raw, unfiltered alerts response,
// to check why "alerts" comes back empty instead of guessing ----
app.get('/api/debug/faz-alerts-raw', async (req, res) => {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    res.json(await fortianalyzer.debugAlertsRaw(hours));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Observium debug endpoints: raw responses for devices, ports,
// alerts, status, sensors, neighbours, alert log, so we can confirm real
// field names on this instance before writing the actual refresh() logic ----
app.get('/api/debug/observium-devices', async (req, res) => {
  try {
    res.json(await observium.fetchDevicesSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/observium-ports', async (req, res) => {
  try {
    res.json(await observium.fetchPortsSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/observium-alerts', async (req, res) => {
  try {
    res.json(await observium.fetchAlertsSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/observium-status', async (req, res) => {
  try {
    res.json(await observium.fetchStatusSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/observium-sensors', async (req, res) => {
  try {
    res.json(await observium.fetchSensorsSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/observium-neighbours', async (req, res) => {
  try {
    res.json(await observium.fetchNeighboursSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/observium-alertlog', async (req, res) => {
  try {
    res.json(await observium.fetchAlertLogSample());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/observium-all', async (req, res) => {
  try {
    res.json(await observium.debugAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Darktrace debug endpoint: raw, unfiltered breaches, so real
// field names and priority values can be checked directly ----
app.get('/api/debug/darktrace-raw', async (req, res) => {
  try {
    const hours = req.query.hours ? parseInt(req.query.hours, 10) : 24;
    res.json(await darktrace.fetchRawBreaches(hours));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Endpoint the dashboard actually calls for tickets ----
app.get('/api/tickets-summary', (req, res) => {
  const entry = cache.get('halo');
  if (!entry.data) {
    return res.status(503).json({ error: 'No Halo data yet', ...entry });
  }
  res.json({ ...entry.data, generatedAt: entry.updatedAt, stale: !entry.ok });
});

// ---- Endpoint the dashboard calls for the Network screen ----
app.get('/api/network-summary', (req, res) => {
  const entry = cache.get('observium');
  if (!entry.data) {
    return res.status(503).json({ error: 'No Observium data yet', ...entry });
  }
  res.json({ ...entry.data, generatedAt: entry.updatedAt, stale: !entry.ok });
});

// ---- Endpoint the dashboard calls for the Security screen ----
app.get('/api/security-summary', (req, res) => {
  const entry = cache.get('fortianalyzer');
  if (!entry.data) {
    return res.status(503).json({ error: 'No FortiAnalyzer data yet', ...entry });
  }
  res.json({ ...entry.data, generatedAt: entry.updatedAt, stale: !entry.ok });
});

// ---- Endpoint the dashboard calls for the Darktrace panel on the Security screen ----
app.get('/api/darktrace-summary', (req, res) => {
  const entry = cache.get('darktrace');
  if (!entry.data) {
    return res.status(503).json({ error: 'No Darktrace data yet', ...entry });
  }
  res.json({ ...entry.data, generatedAt: entry.updatedAt, stale: !entry.ok });
});

// ---- Endpoint the dashboard calls for the Services screen ----
app.get('/api/services-summary', (req, res) => {
  const entry = cache.get('services');
  if (!entry.data) {
    return res.status(503).json({ error: 'No service check data yet', ...entry });
  }
  res.json({ ...entry.data, generatedAt: entry.updatedAt, stale: !entry.ok });
});

// ---- Start each source on its own independent schedule ----
if (DEMO_MODE) {
  demoRunner.start();
} else {
  halo.start();
  fortianalyzer.start();
  observium.start();
  darktrace.start();
  servicecheck.start();
}

// ---- Clean shutdown: log out of FortiAnalyzer so restarts don't leak
// sessions toward its login limit. systemd sends SIGTERM on both
// `systemctl stop` and `systemctl restart`. ----
async function shutdown() {
  if (!DEMO_MODE) await fortianalyzer.logout();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => console.log(`dashboard-api running on port ${PORT}`));
