// FortiGate source module. Not built yet, same pattern as sources/halo.js.
// Threat/traffic logs are event-driven, so when we build this it likely
// wants "give me what's new since X" rather than a full poll each cycle.

const cache = require('../cache');

const CACHE_KEY = 'fortigate';
const REFRESH_INTERVAL_MS = 60 * 1000;

async function refresh() {
  try {
    // TODO: call the FortiGate API here, shape the result, then
    // cache.set(CACHE_KEY, {...}).
    throw new Error('FortiGate source not implemented yet');
  } catch (err) {
    console.error('[fortigate] refresh failed:', err.message);
    cache.setError(CACHE_KEY, err.message);
  }
}

function start() {
  // Not started automatically yet, see server.js.
  // Uncomment when ready:
  // refresh();
  // setInterval(refresh, REFRESH_INTERVAL_MS);
}

module.exports = { start, refresh, CACHE_KEY };
