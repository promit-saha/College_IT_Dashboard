// Demo data generator.
// Produces realistic, randomized data matching the exact same shape the
// real Halo/Observium/FortiAnalyzer/Darktrace/service-check modules
// produce, so the dashboard behaves identically to the real deployment,
// just against fabricated numbers instead of a real school's systems.
// Every function here is pure, no network calls, no credentials needed.

const CAMPUSES = ['North Campus', 'South Campus'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max, decimals = 1) {
  const v = Math.random() * (max - min) + min;
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}
function jitter(base, pct = 0.15) {
  const delta = base * pct;
  return Math.round((base + (Math.random() * 2 - 1) * delta) * 10) / 10;
}

// ---- Tickets (Halo shape) ----

const TECH_NAMES = [
  { name: 'Alex Chen', role: 'Systems Administrator' },
  { name: 'Jordan Patel', role: 'Network Technician' },
  { name: 'Sam Rivera', role: 'IT Support Officer' },
  { name: 'Morgan Lee', role: 'Help Desk Technician' },
  { name: 'Casey Kim', role: 'Infrastructure Engineer' },
];
const CATEGORIES = ['Hardware', 'Software', 'Network', 'Printing', 'Accounts & Access', 'Classroom AV'];
const TICKET_SUMMARIES = [
  'Laptop will not turn on', 'Wifi drops in room 12', 'Printer offline in staff room',
  'Cannot access shared drive', 'Projector no signal', 'Password reset request',
  'New starter equipment setup', 'Slow performance on lab machines', 'Email not syncing',
  'Smartboard unresponsive', 'VPN connection failing', 'Software install request',
];

function buildTicketsDemo() {
  const priority = { high: randInt(3, 10), medium: randInt(8, 20), low: randInt(10, 25) };
  const total = priority.high + priority.medium + priority.low + randInt(150, 300);
  const counts = {
    new: randInt(2, 8),
    pending: randInt(3, 10),
    inProgress: randInt(5, 15),
    solved: total - randInt(10, 40),
    unassigned: randInt(0, 4),
    overdue: randInt(0, 3),
  };
  const categories = CATEGORIES.map(name => ({ name, count: randInt(3, 30) })).sort((a, b) => b.count - a.count);
  const topTechnicians = TECH_NAMES.map(t => ({ ...t, count: randInt(2, 18) })).sort((a, b) => b.count - a.count);

  const ticketList = [];
  const openCount = counts.new + counts.pending + counts.inProgress;
  for (let i = 0; i < Math.min(openCount, 25); i++) {
    const p = i < priority.high * 0.4 ? 'High' : i < priority.high + priority.medium * 0.4 ? 'Medium' : 'Low';
    ticketList.push({
      id: 10000 + randInt(1, 4000),
      user: `student${randInt(1, 900)}@worldsgreatestschool.edu`,
      agent: pick(TECH_NAMES).name,
      summary: pick(TICKET_SUMMARIES),
      category: pick(CATEGORIES),
      priority: p,
    });
  }
  ticketList.sort((a, b) => ({ High: 0, Medium: 1, Low: 2 }[a.priority] - { High: 0, Medium: 1, Low: 2 }[b.priority]));

  return { total, counts, priority, categories, topTechnicians, ticketList };
}

// ---- Network (Observium shape) ----

let throughputHistory = [];
let sessionHistory = [];

function buildThroughputDemo() {
  const sample = {
    t: Date.now(),
    hCoreIn: jitter(420), hCoreOut: jitter(310),
    hFwIn: jitter(180), hFwOut: jitter(140),
    fCoreIn: jitter(95), fCoreOut: jitter(70),
    fFwIn: jitter(40), fFwOut: jitter(30),
  };
  throughputHistory.push(sample);
  if (throughputHistory.length > 40) throughputHistory = throughputHistory.slice(-40);

  return {
    harrisdale: {
      core: { label: 'Core (core-sw-01)', operStatus: 'up', speedGbps: 20, inMbps: sample.hCoreIn, outMbps: sample.hCoreOut },
      firewall: { label: 'Firewall (edge)', operStatus: 'up', speedGbps: 20, inMbps: sample.hFwIn, outMbps: sample.hFwOut },
    },
    forrestdale: {
      core: { label: 'Core (core-sw-02)', operStatus: 'up', speedGbps: 2, inMbps: sample.fCoreIn, outMbps: sample.fCoreOut },
      firewall: { label: 'Firewall (edge)', operStatus: 'up', speedGbps: 2, inMbps: sample.fFwIn, outMbps: sample.fFwOut },
    },
    history: throughputHistory,
  };
}

function buildSessionsDemo() {
  const sample = { t: Date.now(), harrisdale: randInt(9000, 14000), forrestdale: randInt(4000, 7000) };
  sessionHistory.push(sample);
  if (sessionHistory.length > 40) sessionHistory = sessionHistory.slice(-40);
  return { harrisdale: sample.harrisdale, forrestdale: sample.forrestdale, history: sessionHistory };
}

const VLAN_NAMES = ['V10-STAFF', 'V20-STUDENT', 'V30-GUEST', 'V40-IOT', 'V50-PRINT', 'V60-VOIP', 'V70-CCTV'];
function buildTopVlansDemo() {
  const forCampus = () => VLAN_NAMES
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, 4)
    .map(label => ({ label, portLabel: label, mbps: randFloat(5, 190) }))
    .sort((a, b) => b.mbps - a.mbps);
  return { harrisdale: forCampus(), forrestdale: forCampus() };
}

const DEVICE_TYPES = ['network', 'wireless', 'firewall', 'printer', 'server', 'storage', 'power', 'video', 'workstation'];
function buildDeviceHealthDemo() {
  const byType = {};
  let total = 0, down = 0;
  for (const type of DEVICE_TYPES) {
    const up = randInt(2, 12);
    const d = Math.random() < 0.15 ? randInt(1, 2) : 0;
    byType[type] = { up, down: d };
    total += up + d;
    down += d;
  }
  return { total, down, byType };
}

const DEMO_HOSTNAMES = ['sw-lib-02', 'ap-block-c-4', 'printer-staffroom', 'nvr-carpark', 'sw-gym-01', 'ap-oval-2'];
function buildNetworkAlertsDemo() {
  if (Math.random() < 0.5) return [];
  const n = randInt(1, 2);
  const alerts = [];
  for (let i = 0; i < n; i++) {
    alerts.push({
      kind: 'device-down',
      deviceId: randInt(1, 300),
      hostname: pick(DEMO_HOSTNAMES),
      descr: 'Device is down',
      severity: 'critical',
    });
  }
  return alerts;
}

function buildOutagesDemo() {
  const n = randInt(0, 6);
  const outages = [];
  let t = Date.now();
  for (let i = 0; i < n; i++) {
    t -= randInt(5, 90) * 60 * 1000;
    const hostname = pick(DEMO_HOSTNAMES);
    outages.push({ t, deviceId: randInt(1, 300), hostname, type: pick(['network', 'wireless', 'printer']), event: pick(['up', 'down']) });
  }
  return outages;
}

function buildLowTonerDemo() {
  if (Math.random() < 0.6) return [];
  const n = randInt(1, 3);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      deviceId: randInt(1, 300),
      hostname: `printer-${pick(['staffroom', 'library', 'admin', 'artroom'])}`,
      colour: pick(['Black', 'Cyan', 'Magenta', 'Yellow']),
      descr: 'Toner',
      percent: 0,
    });
  }
  return out;
}

function buildNetworkDemo() {
  return {
    throughput: buildThroughputDemo(),
    sessions: buildSessionsDemo(),
    topVlans: buildTopVlansDemo(),
    deviceHealth: buildDeviceHealthDemo(),
    networkAlerts: buildNetworkAlertsDemo(),
    outages: buildOutagesDemo(),
    lowToner: buildLowTonerDemo(),
  };
}

// ---- Security (FortiAnalyzer shape) ----

const URL_CATEGORIES = ['Search Engines', 'Streaming Media', 'Social Networking', 'Education', 'News', 'Cloud Storage', 'Gaming'];
const BLOCKED_CATEGORIES = ['Malware', 'Phishing', 'Gambling', 'Adult Content', 'Proxy Avoidance'];
const ALERT_RULES = ['Insecure SSL Connection blocked', 'Botnet C&C traffic blocked', 'Known malicious IP blocked', 'Suspicious file download blocked'];
const DEMO_COUNTRIES = [
  { country: 'United States', lat: 38, lon: -97 },
  { country: 'Germany', lat: 51, lon: 10 },
  { country: 'Russia', lat: 61, lon: 105 },
  { country: 'China', lat: 35, lon: 105 },
  { country: 'Brazil', lat: -10, lon: -55 },
  { country: 'Netherlands', lat: 52, lon: 5 },
];

function buildSecurityDemo() {
  const sourceTable = Array.from({ length: 4 }, (_, i) => ({
    host: `device-${randInt(100, 999)}`,
    srcip: `10.20.${randInt(0, 5)}.${randInt(2, 250)}`,
    sessions: randInt(20, 400),
    bytes: randInt(5_000_000, 900_000_000),
  }));

  const urlCategories = URL_CATEGORIES.map(name => ({ name, percent: randInt(2, 30) }));

  const blockedCategories = BLOCKED_CATEGORIES.map(name => {
    const c = randInt(1, 60);
    return { name, sessions: c, hits: c };
  }).sort((a, b) => b.sessions - a.sessions);

  const alertCount = randInt(2, 10);
  const alerts = Array.from({ length: alertCount }, () => ({
    message: pick(ALERT_RULES),
    severity: pick(['low', 'low', 'medium', 'medium', 'high', 'info']),
    timestamp: Date.now() - randInt(0, 24 * 60 * 60 * 1000),
    devname: pick(['edge-fw-01', 'edge-fw-02']),
    epname: `device-${randInt(100, 999)}`,
    epip: `10.20.${randInt(0, 5)}.${randInt(2, 250)}`,
    dstepip: `${randInt(20, 210)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(0, 255)}`,
    rule: pick(ALERT_RULES),
  }));

  const eventCount = randInt(4, 12);
  const events = Array.from({ length: eventCount }, () => {
    const c = pick(DEMO_COUNTRIES);
    const d = new Date(Date.now() - randInt(0, 24 * 60 * 60 * 1000));
    const pad = n => String(n).padStart(2, '0');
    return {
      dateLabel: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      category: pick(BLOCKED_CATEGORIES),
      srcip: `10.20.${randInt(0, 5)}.${randInt(2, 250)}`,
      dstip: `${randInt(20, 210)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(0, 255)}`,
      country: c.country,
      countryCode: null,
      lat: c.lat + randFloat(-3, 3),
      lon: c.lon + randFloat(-3, 3),
    };
  });
  const arcTally = {};
  for (const e of events) {
    if (!arcTally[e.country]) arcTally[e.country] = { country: e.country, lat: e.lat, lon: e.lon, count: 0 };
    arcTally[e.country].count++;
  }
  const arcs = Object.values(arcTally).sort((a, b) => b.count - a.count);

  return {
    sourceTable,
    urlCategories,
    blockedCategories,
    alerts,
    threatMap: { events, arcs, source: { lat: -31.95, lon: 115.86, label: "World's Greatest School" } },
  };
}

// ---- Darktrace shape ----

const DARKTRACE_MODELS = [
  { kind: 'SaaS', label: 'Anonymous Sharing Link Created' },
  { kind: 'SaaS', label: 'Unusual External Source for SaaS Credential Use' },
  { kind: 'Compromise', label: 'Slow Beaconing Activity To External Rare' },
  { kind: 'Anomalous Connection', label: 'Uncommon 1 GiB Outbound' },
  { kind: 'SaaS', label: 'Unusual ASN for SaaS Credential' },
  { kind: 'Compliance', label: 'Possible DNS Over HTTPS/TLS' },
];
const DARKTRACE_DEVICES = ['jstudent42', 'kwilliams', 'labpc-14', 'SaaS::Office365: staff.member@worldsgreatestschool.edu', 'front-office-01'];

// Matches sources/darktrace.js exactly: priority >=3 is "high", >=2 is
// "medium", otherwise "low". Scores stay >=70 to match the real
// SCORE_THRESHOLD and the panel's own "70%+" title, so the demo never
// contradicts what it's labeled as showing.
function priorityBandFor(priority) {
  if (priority >= 3) return 'high';
  if (priority >= 2) return 'medium';
  return 'low';
}

function buildDarktraceDemo() {
  const n = randInt(0, 5);
  const breaches = Array.from({ length: n }, () => {
    const m = pick(DARKTRACE_MODELS);
    const score = randInt(70, 95);
    const priority = score >= 85 ? 3 : 2;
    return {
      time: Date.now() - randInt(0, 24 * 60 * 60 * 1000),
      score,
      priority,
      priorityBand: priorityBandFor(priority),
      kind: m.kind,
      label: m.label,
      device: pick(DARKTRACE_DEVICES),
    };
  }).sort((a, b) => b.time - a.time);
  return { breaches };
}

// ---- Services shape ----

function buildServicesDemo(serviceNames) {
  const services = serviceNames.map(name => {
    const roll = Math.random();
    if (roll < 0.94) {
      return { name, url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example.edu`, status: 'up', httpStatus: 200, ms: randInt(80, 900) };
    }
    if (roll < 0.98) {
      return { name, url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example.edu`, status: 'degraded', httpStatus: 503, ms: randInt(200, 2000) };
    }
    return { name, url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example.edu`, status: 'down', httpStatus: null, ms: randInt(9000, 10000), error: 'fetch failed: connect ETIMEDOUT' };
  });
  const down = services.filter(s => s.status === 'down').length;
  const degraded = services.filter(s => s.status === 'degraded').length;
  return { services, down, degraded, total: services.length };
}

module.exports = {
  buildTicketsDemo,
  buildNetworkDemo,
  buildSecurityDemo,
  buildDarktraceDemo,
  buildServicesDemo,
  CAMPUSES,
};
