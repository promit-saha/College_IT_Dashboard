// HaloITSM source module.
// Owns its own auth, its own fetch logic, its own refresh interval.
// A problem here never touches the Observium or FortiGate modules.

const cache = require('../cache');

const CACHE_KEY = 'halo';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // ticket data doesn't need to be near-live
const AGENT_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // agent list barely changes

const HALO_AUTH_URL = process.env.HALO_AUTH_URL;
const HALO_API_URL = process.env.HALO_API_URL;
const HALO_CLIENT_ID = process.env.HALO_CLIENT_ID;
const HALO_CLIENT_SECRET = process.env.HALO_CLIENT_SECRET;
const HALO_SCOPE = process.env.HALO_SCOPE || 'all';

let cachedToken = null;
let tokenExpiresAt = 0;
let agentMap = {}; // agent_id -> { name, jobtitle }, populated by refreshAgents()

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30000) {
    return cachedToken;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: HALO_CLIENT_ID,
    client_secret: HALO_CLIENT_SECRET,
    scope: HALO_SCOPE
  });

  const res = await fetch(HALO_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!res.ok) {
    throw new Error(`Halo auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

async function haloFetch(path) {
  const token = await getToken();
  const res = await fetch(`${HALO_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Halo API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

// "Total" / "Solved" / open breakdown now reset every January 1 (year to
// date), instead of a rolling 365-day lookback. A rolling window meant
// the numbers quietly dropped older tickets every single day, this way
// they only reset once a year, matching how the school year runs.
function startOfCalendarYear() {
  return `${new Date().getFullYear()}-01-01`;
}

function ticketWindowParams() {
  const startdate = startOfCalendarYear();
  const enddate = dateDaysAgo(0);
  return `&datesearch=dateoccurred&startdate=${startdate}&enddate=${enddate}`;
}

async function fetchSampleTicket() {
  return haloFetch('/Tickets?pageinate=true&page_size=1&page_no=1');
}

// Debug: the EXACT same query production refresh() uses for "open"
// tickets (open_only=true), but a bigger page and no field trimming, so
// we can see the raw status fields on tickets that are showing up here
// despite apparently already being closed in Halo.
async function fetchOpenTicketsRawSample() {
  const windowParams = ticketWindowParams();
  return haloFetch(`/Tickets?pageinate=true&page_size=50&page_no=1&open_only=true${windowParams}`);
}

async function fetchAgents() {
  return haloFetch('/Agent');
}

async function fetchTicketTypes() {
  return haloFetch('/TicketType');
}

// Matches Halo's own "Requests by Agent" widget: same view_id=1 as
// Incidents, but ticketarea_id=4 for the Requests area, captured from
// Halo's frontend network request and confirmed against
// /api/debug/halo-requests-count (117 vs the widget's own ~119).
async function fetchOpenRequestsByAgent() {
  return fetchPaginated('&view_id=1&ticketarea_id=4');
}

// Matches Halo's own "Incidents by Agent" widget exactly: view_id=1 plus
// ticketarea_id=1, captured straight from Halo's frontend network request
// and confirmed against /api/debug/halo-view-filter (118 vs the widget's
// own ~117). No open_only or tickettype_id needed, this combination
// already carries both filters.
async function fetchOpenIncidentsByAgent() {
  return fetchPaginated('&view_id=1&ticketarea_id=1');
}

async function refreshAgents() {
  try {
    const agents = await fetchAgents();
    const map = {};
    for (const a of agents) {
      map[a.id] = { name: a.name, jobtitle: a.jobtitle || '' };
    }
    agentMap = map;
  } catch (err) {
    console.error('[halo] agent list refresh failed:', err.message);
  }
}

async function getRecordCount(extraParams = '') {
  const data = await haloFetch(`/Tickets?pageinate=true&page_size=1&page_no=1${extraParams}`);
  return typeof data.record_count === 'number' ? data.record_count : 0;
}

async function fetchPaginated(extraParams) {
  const pageSize = 100;
  const seenIds = new Set();
  let all = [];
  let pageNo = 1;

  while (pageNo <= 40) { // safety cap, ~4000 tickets, plenty of headroom
    const data = await haloFetch(`/Tickets?pageinate=true&page_size=${pageSize}&page_no=${pageNo}${extraParams}`);
    const tickets = data.tickets || data.items || data;
    if (!Array.isArray(tickets) || tickets.length === 0) break;

    const newTickets = tickets.filter(t => !seenIds.has(t.id));
    if (newTickets.length === 0) break;

    newTickets.forEach(t => seenIds.add(t.id));
    all = all.concat(newTickets);

    if (tickets.length < pageSize) break;
    pageNo++;
  }

  return all;
}

async function refresh() {
  try {
    const windowParams = ticketWindowParams();
    const [totalCount, solvedCount, openTickets, incidentsByAgent, requestsByAgent] = await Promise.all([
      getRecordCount(windowParams),
      getRecordCount(`&closed_only=true${windowParams}`),
      fetchPaginated(`&open_only=true${windowParams}`),
      fetchOpenIncidentsByAgent(),
      fetchOpenRequestsByAgent()
    ]);

    const counts = { new: 0, pending: 0, inProgress: 0, solved: solvedCount, unassigned: 0, overdue: 0 };
    const priority = { high: 0, medium: 0, low: 0 };
    const categoryTally = {};
    const techTally = {};
    const ticketList = [];
    const now = Date.now();

    for (const t of openTickets) {
      // Confirmed real bug: Halo's own open_only=true filter doesn't
      // reliably exclude tickets closed via every closure path (e.g.
      // "Closed (No Response)"). status_id alone can't tell the
      // difference either, closed and open tickets were observed
      // sharing the same status_id. hasbeenclosed is the one field that
      // was actually different on a real closed-but-still-returned
      // ticket, so it's checked explicitly here rather than trusted to
      // the query parameter.
      if (t.hasbeenclosed) continue;

      // These fields are directly observed from the real Halo response,
      // not guessed: onhold, dateassigned, fixbydate, category_1_display.
      const onHold = t.onhold === true;
      const assigned = !!t.dateassigned;
      const dueDate = t.fixbydate ? new Date(t.fixbydate).getTime() : null;
      const categoryName = (t.category_1_display || '').trim();

      if (!assigned) counts.unassigned++;

      if (onHold) counts.pending++;
      else if (assigned) counts.inProgress++;
      else counts.new++;

      if (dueDate && dueDate < now) counts.overdue++;

      // NOTE: priority_id -> bucket mapping is a common Halo default
      // (1/2 = high urgency, 3 = medium, 4 = low). Confirm against
      // Configuration > Tickets > Priorities in your Halo admin and
      // adjust these three lines if yours differs.
      let priorityLabel;
      let priorityRank;
      if (t.priority_id === 1 || t.priority_id === 2) {
        priority.high++;
        priorityLabel = 'High';
        priorityRank = 0;
      } else if (t.priority_id === 3) {
        priority.medium++;
        priorityLabel = 'Medium';
        priorityRank = 1;
      } else {
        priority.low++;
        priorityLabel = 'Low';
        priorityRank = 2;
      }

      // Uncategorized tickets (blank category) are excluded entirely,
      // not bucketed, per the "ignore Uncategorized everywhere" rule.
      if (categoryName) {
        categoryTally[categoryName] = (categoryTally[categoryName] || 0) + 1;
      }

      // Raw per-ticket rows for the "Open ticket list" table. agent comes
      // from agentMap (same lookup topTechnicians uses below), so agent id
      // 1 resolves to "Unassigned" instead of a raw id.
      const agentInfo = agentMap[t.agent_id] || {};
      ticketList.push({
        id: t.id,
        user: t.user_name || '',
        agent: agentInfo.name || (t.agent_id ? `Agent #${t.agent_id}` : 'Unassigned'),
        summary: t.summary || '',
        category: categoryName || 'Uncategorized',
        priority: priorityLabel,
        priorityRank
      });
    }

    // Most urgent first. Capped at 25 rows, this is meant for a TV-sized
    // scrollable panel, not a full ticket export, adjust the slice below
    // if a different cutoff is wanted.
    ticketList.sort((a, b) => a.priorityRank - b.priorityRank);
    const topTicketList = ticketList.slice(0, 25).map(({ priorityRank, ...t }) => t);

    // Open Incidents + open Requests per agent, including Unassigned
    // (agent id 1, Halo's own placeholder, confirmed via /api/Agent).
    // Both lists already come pre-filtered by their respective fetch
    // functions above, this just adds the two counts together per agent.
    for (const t of incidentsByAgent) {
      const agentId = t.agent_id;
      if (agentId) {
        techTally[agentId] = (techTally[agentId] || 0) + 1;
      }
    }
    for (const t of requestsByAgent) {
      const agentId = t.agent_id;
      if (agentId) {
        techTally[agentId] = (techTally[agentId] || 0) + 1;
      }
    }

    const categories = Object.entries(categoryTally)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const topTechnicians = Object.entries(techTally)
      .map(([id, count]) => {
        const info = agentMap[id] || {};
        return { name: info.name || `Agent #${id}`, role: info.jobtitle || '', count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 7);

    cache.set(CACHE_KEY, { total: totalCount, counts, priority, categories, topTechnicians, ticketList: topTicketList });
  } catch (err) {
    console.error('[halo] refresh failed:', err.message);
    cache.setError(CACHE_KEY, err.message);
  }
}

function start() {
  refreshAgents();
  setInterval(refreshAgents, AGENT_REFRESH_INTERVAL_MS);

  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

module.exports = { start, refresh, fetchSampleTicket, fetchOpenTicketsRawSample, fetchAgents, fetchTicketTypes, CACHE_KEY };
