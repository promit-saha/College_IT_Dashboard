// Simple shared-password gate for the whole dashboard. One password for
// everyone (matches how every other credential in this project works,
// a single shared secret in .env, not per-user accounts), since this
// is a shared TV display, not a multi-user system.
//
// Sessions are persisted to sessions.json rather than kept only in
// memory, so a server restart (which has happened a lot during active
// development) doesn't force everyone to log back in, same lesson
// learned from the outage log losing its history on every restart.
//
// Note on "stay logged in forever": Chrome caps cookie lifetime at 400
// days regardless of what's requested (a privacy feature added in
// 2023), so this is set to that practical maximum, not literally
// infinite. After ~400 days of not logging in again, it'll ask again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const COOKIE_NAME = 'dashboard_session';
const MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000; // Chrome's actual ceiling, not truly infinite

function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions.push({ token, created: new Date().toISOString() });
  saveSessions(sessions);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const sessions = loadSessions();
  return sessions.some(s => s.token === token);
}

// Constant-time comparison, so response timing can't leak how many
// characters of a guessed password were right.
function checkPassword(candidate) {
  const real = process.env.DASHBOARD_PASSWORD || '';
  if (!real) return false; // refuse to "succeed" if nothing's configured yet
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(real);
  if (a.length !== b.length) {
    // Still do a same-cost comparison so wrong-length guesses take
    // about as long as right-length ones, rather than failing instantly.
    crypto.timingSafeEqual(Buffer.alloc(b.length), Buffer.alloc(b.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

module.exports = { COOKIE_NAME, MAX_AGE_MS, createSession, isValidSession, checkPassword, parseCookies };
