// Simple in-memory cache shared by every source.
// Each entry stores the last good data plus when it was fetched, so a
// failed poll doesn't wipe out the last known value, it just goes stale.

const store = {};

function set(key, data) {
  store[key] = { data, updatedAt: new Date().toISOString(), ok: true };
}

function setError(key, message) {
  const existing = store[key];
  store[key] = {
    data: existing ? existing.data : null,
    updatedAt: existing ? existing.updatedAt : null,
    ok: false,
    error: message
  };
}

function get(key) {
  return store[key] || { data: null, updatedAt: null, ok: false, error: 'not fetched yet' };
}

function getAll() {
  return store;
}

module.exports = { set, setError, get, getAll };
