// Demo mode runner.
// When DEMO_MODE=true, this replaces the real source modules' start()
// calls entirely, no network calls, no credentials needed at all. It
// writes into the exact same cache keys the real modules use
// ('halo', 'observium', 'fortianalyzer', 'darktrace', 'services'), so
// every API route and the entire frontend work completely unmodified,
// they have no way to tell the difference between this and a real
// deployment.
//
// The real source files (sources/halo.js, observium.js, etc.) are left
// completely untouched, this file never even requires them. They stay
// in this repo exactly as they'd look in a real deployment, showing the
// actual integration patterns (OAuth client_credentials, HMAC-SHA1
// request signing, FortiAnalyzer's JSON-RPC session handling, and so
// on), they're just never the code path that actually runs when
// DEMO_MODE is on.

const cache = require('../cache');
const demo = require('./demo-data');

const SERVICE_NAMES = [
  'Student Portal', 'Staff Portal', 'Library System', 'Learning Management System',
  'Timetabling', 'Print Management', 'VOIP Phone System', 'Enrolment System',
  'Payments Portal', 'Wellbeing Platform', 'Sports Bookings', 'Visitor Check-In',
];

function start() {
  console.log('[demo] Running in DEMO_MODE, all data is randomly generated. No real credentials or network calls are used.');

  function refreshTickets() { cache.set('halo', demo.buildTicketsDemo()); }
  function refreshNetwork() { cache.set('observium', demo.buildNetworkDemo()); }
  function refreshSecurity() { cache.set('fortianalyzer', demo.buildSecurityDemo()); }
  function refreshDarktrace() { cache.set('darktrace', demo.buildDarktraceDemo()); }
  function refreshServices() { cache.set('services', demo.buildServicesDemo(SERVICE_NAMES)); }

  refreshTickets();
  refreshNetwork();
  refreshSecurity();
  refreshDarktrace();
  refreshServices();

  // Same cadence as the real sources, so charts and history fill in at
  // a realistic pace rather than jumping around too fast to look real.
  setInterval(refreshTickets, 5 * 60 * 1000);
  setInterval(refreshNetwork, 30 * 1000);
  setInterval(refreshSecurity, 5 * 60 * 1000);
  setInterval(refreshDarktrace, 2 * 60 * 1000);
  setInterval(refreshServices, 3 * 60 * 1000);
}

module.exports = { start };
