// Observium source module.
//
// NOTE (demo build): this file is real, unmodified integration code,
// but it's never actually called in DEMO_MODE, see
// sources/demo-runner.js, which populates the same cache key with
// generated data instead. The device IDs, ports, and campus names
// below are fictional placeholders illustrating the kind of
// site-specific configuration a real deployment would confirm against
// its own Observium instance, not real infrastructure.
//
// Example confirmed-against-the-real-instance style comments, for
// illustration:
//   - North Campus core = device 105 ("core-north"), link port 3378 ("lg45", 20Gbps)
//   - North Campus firewall = device 95 (edge-fw-north), link port 2924
//     ("CORE-LINK", alias "V10-MGMT", 20Gbps)
//   - South Campus core = device 59 ("core-south"), link port 2748 ("lg1", 2Gbps)
//   - South Campus firewall = device 96 (edge-fw-south), link port 2991
//     ("CORE-LINK", alias "V10-MGMT-LAN", 2Gbps)
//   Each pair confirmed the same way: matching speed AND matching octet
//   rate on both ends of the link, not by name alone.
//   - Bandwidth fields are bytes/sec (ifInOctets_rate/ifOutOctets_rate),
//     not bits/sec.
//   - VLAN interfaces on both firewalls are named "V<digits>..." or
//     "V-<digits>..." (e.g. V10-MGMT, V-18-LAN), confirmed by scanning
//     every real port label on both devices. System/infra ports (port1,
//     CORE-LINK, ha, mgmt, x1-x8, modem, fortilink, CAR-*-VDC, etc) don't
//     match that pattern, so it cleanly separates the two without a
//     hardcoded exclude-list.
//   - Printer supply_value is always 0-100 regardless of what
//     supply_capacity says (confirmed: never once saw a value above 100
//     across ~300 real supply rows, including ones with capacity 5000+).
//     supply_capacity is NOT a divisor for a percentage on this instance.
//   - Waste toner box level reads exactly 80 on every single printer
//     checked, different models, different real toner levels, so that
//     one field looks static rather than live. Toner alerting below only
//     uses supply_type "toner", not wastetoner/drum/developer/etc.
//   - Observium's own /alerts/ and /alert_log/ are both empty on this
//     instance, so down-state and outage history are built from each
//     device's own status field instead.
//   - /groups/?entity_type=device returned 0 groups, so the device-type
//     breakdown is built from each device's own `type` field, grouped
//     dynamically rather than off a hardcoded category list.
//
// Outage log persistence: entries are written to outage-log.json (not
// just kept in memory) and reloaded on startup, pruned to the last 24
// hours on every load and every update. Without this, every container
// restart silently wiped the whole log, which happened often enough
// during active development to be a real, recurring problem, not a
// theoretical one.

const fs = require('fs');
const path = require('path');
const cache = require('../cache');

const CACHE_KEY = 'observium';
const REFRESH_INTERVAL_MS = 30 * 1000;

const OBSERVIUM_API_URL = process.env.OBSERVIUM_API_URL;
const OBSERVIUM_API_TOKEN = process.env.OBSERVIUM_API_TOKEN;

const SITES = {
  harrisdale: {
    label: 'North Campus',
    corePortId: 3378,
    coreLabel: 'Core (lg45)',
    fwPortId: 2924,
    fwLabel: 'Firewall (CORE-LINK)',
    fwDeviceId: '95'
  },
  forrestdale: {
    label: 'South Campus',
    corePortId: 2748,
    coreLabel: 'Core (lg1)',
    fwPortId: 2991,
    fwLabel: 'Firewall (CORE-LINK)',
    fwDeviceId: '96'
  }
};

// Real VLAN interfaces on both firewalls are named "V123..." or
// "V-123...", confirmed against every port label on both devices.
const VLAN_LABEL_PATTERN = /^V-?\d/i;
const TOP_VLAN_COUNT = 4;

const NETWORK_HEALTH_TYPES = ['network', 'wireless', 'firewall'];

const HISTORY_MAX_SAMPLES = 240;   // 2 hours at 30s refresh
const OUTAGE_LOG_MAX_ENTRIES = 100; // safety cap, in addition to the 24h age limit below
const OUTAGE_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const OUTAGE_LOG_FILE = path.join(__dirname, '..', 'outage-log.json');
const TONER_LOW_THRESHOLD = 0;     // percent, 0 = completely empty only

let throughputHistory = [];
let sessionHistory = [];
let outageLog = [];
let previousDeviceStatus = null; // null until first successful poll, so we don't log fake "transitions" on startup

// ---- Outage log persistence ----

function loadOutageLog() {
  try {
    const raw = fs.readFileSync(OUTAGE_LOG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - OUTAGE_LOG_MAX_AGE_MS;
    return parsed.filter(e => typeof e.t === 'number' && e.t >= cutoff);
  } catch (err) {
    return []; // file doesn't exist yet, or is unreadable, start fresh either way
  }
}

function saveOutageLog() {
  try {
    fs.writeFileSync(OUTAGE_LOG_FILE, JSON.stringify(outageLog, null, 2));
  } catch (err) {
    console.error('[observium] failed to save outage log:', err.message);
  }
}

async function obsFetch(path) {
  const res = await fetch(`${OBSERVIUM_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${OBSERVIUM_API_TOKEN}` }
  });
  if (!res.ok) {
    throw new Error(`Observium API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ---- Debug fetchers, kept from earlier troubleshooting ----

async function fetchDevicesSample() { return obsFetch('/devices/?pagesize=5'); }
async function fetchPortsSample() { return obsFetch('/ports/?pagesize=10'); }
async function fetchAlertsSample() { return obsFetch('/alerts/?pagesize=10'); }
async function fetchStatusSample() { return obsFetch('/status/?pagesize=10'); }
async function fetchSensorsSample() { return obsFetch('/sensors/?pagesize=10'); }
async function fetchNeighboursSample() { return obsFetch('/neighbours/?pagesize=10'); }
async function fetchAlertLogSample() { return obsFetch('/alert_log/?pagesize=10'); }

async function debugAll() {
  const checks = {
    devices: fetchDevicesSample, ports: fetchPortsSample, alerts: fetchAlertsSample,
    status: fetchStatusSample, sensors: fetchSensorsSample,
    neighbours: fetchNeighboursSample, alertLog: fetchAlertLogSample
  };
  const results = {};
  for (const [name, fn] of Object.entries(checks)) {
    try {
      const data = await fn();
      results[name] = { ok: true, count: Number(data.count) || 0 };
    } catch (err) {
      results[name] = { ok: false, error: err.message };
    }
  }
  return results;
}

// ---- Shared fetchers ----

async function fetchAllDevices() {
  const data = await obsFetch('/devices/?pagesize=200&fields=device_id,hostname,type,status');
  return Object.values(data.devices || {});
}

async function fetchPort(portId) {
  const data = await obsFetch(
    `/ports/?port_id=${portId}&fields=port_id,port_label,ifAlias,ifOperStatus,ifSpeed,ifInOctets_rate,ifOutOctets_rate`
  );
  const rows = data.ports || {};
  return rows[portId] || Object.values(rows)[0] || null;
}

async function fetchAllPorts(deviceId) {
  const data = await obsFetch(
    `/ports/?device_id=${deviceId}&fields=port_id,port_label,ifAlias,ifOperStatus,ifOctets_rate`
  );
  return Object.values(data.ports || {});
}

function bytesRateToMbps(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  return Math.round(((n * 8) / 1_000_000) * 10) / 10;
}

// ---- Throughput: both sites' core<->firewall links ----

async function buildSiteThroughput(site) {
  const [corePort, fwPort] = await Promise.all([
    fetchPort(site.corePortId),
    fetchPort(site.fwPortId)
  ]);

  const core = corePort ? {
    label: site.coreLabel,
    portId: site.corePortId,
    operStatus: corePort.ifOperStatus,
    speedGbps: Number(corePort.ifSpeed) / 1_000_000_000,
    inMbps: bytesRateToMbps(corePort.ifInOctets_rate),
    outMbps: bytesRateToMbps(corePort.ifOutOctets_rate)
  } : null;

  const firewall = fwPort ? {
    label: site.fwLabel,
    portId: site.fwPortId,
    operStatus: fwPort.ifOperStatus,
    speedGbps: Number(fwPort.ifSpeed) / 1_000_000_000,
    inMbps: bytesRateToMbps(fwPort.ifInOctets_rate),
    outMbps: bytesRateToMbps(fwPort.ifOutOctets_rate)
  } : null;

  return { core, firewall };
}

async function buildThroughput() {
  const [harrisdale, forrestdale] = await Promise.all([
    buildSiteThroughput(SITES.harrisdale),
    buildSiteThroughput(SITES.forrestdale)
  ]);

  const sample = {
    t: Date.now(),
    hCoreIn: harrisdale.core?.inMbps ?? null,
    hCoreOut: harrisdale.core?.outMbps ?? null,
    hFwIn: harrisdale.firewall?.inMbps ?? null,
    hFwOut: harrisdale.firewall?.outMbps ?? null,
    fCoreIn: forrestdale.core?.inMbps ?? null,
    fCoreOut: forrestdale.core?.outMbps ?? null,
    fFwIn: forrestdale.firewall?.inMbps ?? null,
    fFwOut: forrestdale.firewall?.outMbps ?? null
  };
  throughputHistory.push(sample);
  if (throughputHistory.length > HISTORY_MAX_SAMPLES) {
    throughputHistory = throughputHistory.slice(-HISTORY_MAX_SAMPLES);
  }

  return { harrisdale, forrestdale, history: throughputHistory };
}

// ---- Active sessions on both firewalls ----
// fgSysSesCount is a standard Fortinet MIB object (FORTINET-FORTIGATE-MIB),
// confirmed present on device 95 as sensor_descr "Active Sessions", real
// value 124299 at the time this was checked. Looked up by sensor_object
// name rather than a hardcoded sensor_id, since that ID differs per
// device but the object name is the same across any FortiGate.
async function fetchSessionCount(deviceId) {
  const data = await obsFetch(`/sensors/?device_id=${deviceId}`);
  const sensors = Object.values(data.sensors || {});
  const match = sensors.find(s => s.sensor_object === 'fgSysSesCount');
  return match ? Math.round(Number(match.sensor_value)) : null;
}

async function buildSessionCounts() {
  const [harrisdale, forrestdale] = await Promise.all([
    fetchSessionCount(SITES.harrisdale.fwDeviceId),
    fetchSessionCount(SITES.forrestdale.fwDeviceId)
  ]);

  const sample = { t: Date.now(), harrisdale, forrestdale };
  sessionHistory.push(sample);
  if (sessionHistory.length > HISTORY_MAX_SAMPLES) {
    sessionHistory = sessionHistory.slice(-HISTORY_MAX_SAMPLES);
  }

  return { harrisdale, forrestdale, history: sessionHistory };
}

// ---- Top VLANs by traffic, both firewalls ----

async function buildTopVlans() {
  const [harPorts, forPorts] = await Promise.all([
    fetchAllPorts(SITES.harrisdale.fwDeviceId),
    fetchAllPorts(SITES.forrestdale.fwDeviceId)
  ]);

  function topVlans(ports) {
    return ports
      .filter(p => VLAN_LABEL_PATTERN.test(p.port_label || ''))
      .map(p => ({
        label: p.ifAlias || p.port_label,
        portLabel: p.port_label,
        mbps: bytesRateToMbps(p.ifOctets_rate)
      }))
      .sort((a, b) => b.mbps - a.mbps)
      .slice(0, TOP_VLAN_COUNT);
  }

  // Kept separate per campus, not merged into one ranking, they're
  // different physical networks and mixing them made it unclear which
  // VLAN belonged to which site.
  return {
    harrisdale: topVlans(harPorts),
    forrestdale: topVlans(forPorts)
  };
}

// ---- Device health: dynamic grouping by type, no hardcoded categories ----

function buildDeviceHealth(devices) {
  const byType = {};
  let down = 0;

  for (const d of devices) {
    const type = d.type || 'other';
    if (!byType[type]) byType[type] = { up: 0, down: 0 };
    if (d.status === '1') {
      byType[type].up++;
    } else {
      byType[type].down++;
      down++;
    }
  }

  return { total: devices.length, down, byType };
}

// ---- Network alerts: down network-type devices + non-ok/non-ignored status entries ----

async function buildNetworkAlerts(devices) {
  const networkDevices = devices.filter(d => NETWORK_HEALTH_TYPES.includes(d.type));
  const networkDeviceIds = new Set(networkDevices.map(d => d.device_id));

  const alerts = [];

  for (const d of networkDevices) {
    if (d.status !== '1') {
      alerts.push({ kind: 'device-down', deviceId: d.device_id, hostname: d.hostname, descr: 'Device is down', severity: 'critical' });
    }
  }

  const statusData = await obsFetch('/status/?pagesize=1000');
  const statusRows = Object.values(statusData.statuses || {});
  for (const s of statusRows) {
    if (!networkDeviceIds.has(s.device_id)) continue;
    if (s.status_event === 'ok' || s.status_event === 'ignore') continue;
    const device = networkDevices.find(d => d.device_id === s.device_id);
    alerts.push({
      kind: 'status', deviceId: s.device_id, hostname: device ? device.hostname : s.device_id,
      descr: s.status_descr, event: s.status_event, eventDescr: s.event_descr, severity: s.severity
    });
  }

  return alerts;
}

// ---- Outage log: every monitored device, state-transition based ----
// Persisted to disk (see loadOutageLog/saveOutageLog above), pruned to
// the last 24 hours on every cycle, not just on load, so entries age out
// on their own even between restarts.

function updateOutageLog(devices) {
  const currentStatus = {};
  for (const d of devices) currentStatus[d.device_id] = d.status;

  if (previousDeviceStatus !== null) {
    let changed = false;

    for (const d of devices) {
      const prev = previousDeviceStatus[d.device_id];
      const curr = d.status;
      if (prev === undefined || prev === curr) continue; // no prior baseline, or unchanged

      outageLog.unshift({
        t: Date.now(),
        deviceId: d.device_id,
        hostname: d.hostname,
        type: d.type || 'other',
        event: curr === '1' ? 'up' : 'down'
      });
      changed = true;
    }

    const cutoff = Date.now() - OUTAGE_LOG_MAX_AGE_MS;
    const beforePrune = outageLog.length;
    outageLog = outageLog.filter(e => e.t >= cutoff);
    if (outageLog.length !== beforePrune) changed = true;

    if (outageLog.length > OUTAGE_LOG_MAX_ENTRIES) {
      outageLog = outageLog.slice(0, OUTAGE_LOG_MAX_ENTRIES);
      changed = true;
    }

    if (changed) saveOutageLog();
  }

  previousDeviceStatus = currentStatus;
  return outageLog;
}

// ---- Printer toner, near-empty only ----

async function buildLowToner(devices) {
  const deviceMap = {};
  for (const d of devices) deviceMap[d.device_id] = d.hostname;

  const data = await obsFetch('/printersupplies/?pagesize=500');
  const rows = Object.values(data.printersupplies || {});

  return rows
    .filter(s => s.supply_type === 'toner' && Number(s.supply_value) <= TONER_LOW_THRESHOLD)
    .map(s => ({
      deviceId: s.device_id,
      hostname: deviceMap[s.device_id] || s.device_id,
      colour: s.supply_colour || '',
      descr: s.supply_descr,
      percent: Number(s.supply_value)
    }))
    .sort((a, b) => a.percent - b.percent);
}

async function refresh() {
  try {
    const devices = await fetchAllDevices();

    const [throughput, sessions, topVlans, networkAlerts, lowToner] = await Promise.all([
      buildThroughput(),
      buildSessionCounts(),
      buildTopVlans(),
      buildNetworkAlerts(devices),
      buildLowToner(devices)
    ]);

    const deviceHealth = buildDeviceHealth(devices);
    const outages = updateOutageLog(devices);

    cache.set(CACHE_KEY, { throughput, sessions, topVlans, deviceHealth, networkAlerts, outages, lowToner });
  } catch (err) {
    console.error('[observium] refresh failed:', err.message);
    cache.setError(CACHE_KEY, err.message);
  }
}

function start() {
  outageLog = loadOutageLog();
  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

module.exports = {
  start, refresh,
  fetchDevicesSample, fetchPortsSample, fetchAlertsSample, fetchStatusSample,
  fetchSensorsSample, fetchNeighboursSample, fetchAlertLogSample, debugAll,
  CACHE_KEY
};
