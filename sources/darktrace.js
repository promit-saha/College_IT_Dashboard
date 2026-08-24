// Darktrace source module.
//
// Auth confirmed working against the real instance: HMAC-SHA1 over
// "{path}{sortedQuery}\n{publicToken}\n{date}", keyed with the private
// token, hex-encoded. The newline separators are the part that's easy
// to get wrong, this was cross-checked against two independent working
// implementations (Ruby and PowerShell) before being tested live.
//
// Schema confirmed from a real 7-day pull of /modelbreaches (152 rows):
//   - percentscore: 0-100, Darktrace's own confidence/anomaly score.
//     Filtering at >=60 gave 7 of 152 over a week on this instance, a
//     usable signal-to-noise ratio, not empty, not noisy.
//   - model.now.priority: 0-5. Confirmed by the person running this,
//     not guessed: 3-5 high, 1-2 medium, 0-1 low. (0 and 1 both listed
//     as covering "low", treated as low here since 1 is also inside the
//     medium range as stated; this only affects the badge color, not
//     the score-based filter itself.)
//   - device.hostname: present on BOTH SaaS breaches ("SaaS::Office365:
//     user@domain") and plain network breaches ("klacey"), confirmed
//     from a real non-SaaS example (a beaconing detection), so no
//     separate code path is needed for the two breach shapes.
//   - model.now.name: dot-path style, e.g.
//     "SaaS::Access::Unusual External Source for SaaS Credential Use".
//     Split on "::", last segment is a readable label, first segment is
//     a category/kind badge.

const crypto = require('crypto');
const cache = require('../cache');

const CACHE_KEY = 'darktrace';
const REFRESH_INTERVAL_MS = 2 * 60 * 1000; // security alerts, keep this reasonably fresh

const DARKTRACE_HOST = (process.env.DARKTRACE_HOST || '').replace(/\/$/, '');
const DARKTRACE_PUBLIC_TOKEN = process.env.DARKTRACE_PUBLIC_TOKEN;
const DARKTRACE_PRIVATE_TOKEN = process.env.DARKTRACE_PRIVATE_TOKEN;

const SCORE_THRESHOLD = 70;   // percent, raised from the original 60 on request
const LOOKBACK_HOURS = 24 * 7; // 7 days, changed from 24h after confirming real breaches were scoring 70%+ but sitting just outside a 24h window
const MAX_ROWS = 30;          // raised from 12: a real 7-day pull already had 15 real 70%+ entries, the panel has a visible scrollbar for exactly this, so the cap no longer needs to be tight

function darktraceDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function buildSignature(path, params, date) {
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys.length
    ? '?' + sortedKeys.map(k => `${k}=${params[k]}`).join('&')
    : '';
  const message = `${path}${queryString}\n${DARKTRACE_PUBLIC_TOKEN}\n${date}`;
  const signature = crypto
    .createHmac('sha1', DARKTRACE_PRIVATE_TOKEN)
    .update(message)
    .digest('hex');
  return { queryString, signature };
}

async function darktraceFetch(path, params = {}) {
  const date = darktraceDate();
  const { queryString, signature } = buildSignature(path, params, date);

  const res = await fetch(`${DARKTRACE_HOST}${path}${queryString}`, {
    headers: {
      'DTAPI-Token': DARKTRACE_PUBLIC_TOKEN,
      'DTAPI-Date': date,
      'DTAPI-Signature': signature,
      'Content-Type': 'application/json'
    }
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Darktrace API error ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

// ---- Debug fetcher: raw, unfiltered, for troubleshooting ----
async function fetchRawBreaches(hours = 24) {
  const endtime = Date.now();
  const starttime = endtime - hours * 60 * 60 * 1000;
  const data = await darktraceFetch('/modelbreaches', { starttime, endtime });
  return Array.isArray(data) ? data : (data.modelbreaches || data.items || []);
}

// "SaaS::Access::Unusual External Source for SaaS Credential Use"
// -> { kind: "SaaS", label: "Unusual External Source for SaaS Credential Use" }
function splitModelName(name) {
  const parts = (name || '').split('::');
  return {
    kind: parts.length > 1 ? parts[0] : 'Other',
    label: parts.length > 1 ? parts[parts.length - 1] : (name || 'Unknown')
  };
}

function priorityBand(priority) {
  const p = Number(priority);
  if (p >= 3) return 'high';
  if (p >= 2) return 'medium';
  return 'low';
}

async function buildBreaches() {
  const raw = await fetchRawBreaches(LOOKBACK_HOURS);

  const breaches = raw
    .filter(b => Number(b.percentscore) >= SCORE_THRESHOLD)
    .map(b => {
      const { kind, label } = splitModelName(b.model?.now?.name);
      return {
        time: b.time,
        score: Math.round(Number(b.percentscore)),
        priority: Number(b.model?.now?.priority),
        priorityBand: priorityBand(b.model?.now?.priority),
        kind,
        label,
        device: b.device?.hostname || b.device?.saasmodule || 'Unknown device'
      };
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, MAX_ROWS);

  return breaches;
}

async function refresh() {
  try {
    const breaches = await buildBreaches();
    cache.set(CACHE_KEY, { breaches });
  } catch (err) {
    console.error('[darktrace] refresh failed:', err.message);
    cache.setError(CACHE_KEY, err.message);
  }
}

function start() {
  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

module.exports = { start, refresh, fetchRawBreaches, CACHE_KEY };
