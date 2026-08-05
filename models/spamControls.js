const { sql } = require('../utils/db_connect');

// Blocklists and the submission log — see migrations/010_spam_controls.sql.
//
// The point of the blocked_entry table is that blocking a spammer stops being a code
// change. It used to mean editing controllers/contactusController.js (26 email addresses
// and ~180 phrases hardcoded in two arrays) and running a deploy.
//
// Ported from the Stockport league site, but rewritten for this project's driver: Stockport
// uses a db.otherConnect().query() wrapper with `?` placeholders, whereas here every query
// is a `postgres` v3 tagged template (see CLAUDE.md — never string-concatenated SQL).
//
// The lists are cached in memory because the IP list is consulted on *every* request, and
// a DB round trip per request to check a list of a hundred strings would be absurd. The
// cache is refreshed lazily on a TTL, so an admin change takes effect within a minute
// without needing a restart or a cross-instance invalidation mechanism.
const CACHE_TTL_MS = 60 * 1000;

const cache = {
  loadedAt: 0,
  ip: new Set(),
  email: new Set(),
  phrase: [],
  word: [],
};

async function load() {
  const rows = await sql`
    SELECT kind, value FROM blocked_entry WHERE active ORDER BY id`;
  const next = { ip: new Set(), email: new Set(), phrase: [], word: [] };
  for (const row of rows) {
    const value = String(row.value || '').trim();
    if (!value) continue;
    if (row.kind === 'ip') next.ip.add(value);
    else if (row.kind === 'email') next.email.add(value.toLowerCase());
    else if (row.kind === 'phrase') next.phrase.push(value.toLowerCase());
    else if (row.kind === 'word') next.word.push(value.toLowerCase());
  }
  cache.ip = next.ip;
  cache.email = next.email;
  cache.phrase = next.phrase;
  cache.word = next.word;
  cache.loadedAt = Date.now();
  return cache;
}

// Never throws. A database hiccup must not take the site down or, worse, fail closed and
// reject every submission — it degrades to "the lists are whatever we last loaded", which
// for a fresh instance means empty. The captcha, honeypot and timing floor are all still
// in force in that state.
async function ensureLoaded() {
  if (Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  try {
    return await load();
  } catch (err) {
    console.error('spamControls: could not load blocklists:', err.message);
    // Push the clock forward so a broken DB isn't retried on every single request.
    cache.loadedAt = Date.now();
    return cache;
  }
}

exports.refresh = load;

// Exported so app.js's refresh timer runs on this exact interval rather than its own
// copy of "60 seconds", and so a test can check it against the pool's idle_timeout —
// if the timeout is the shorter of the two, every tick opens a fresh DB connection.
exports.CACHE_TTL_MS = CACHE_TTL_MS;

// Test seam: lets the suite install known lists without a DB. Sets loadedAt so
// ensureLoaded() treats them as fresh.
exports._setCacheForTests = function (lists) {
  cache.ip = new Set(lists.ip || []);
  cache.email = new Set((lists.email || []).map(e => e.toLowerCase()));
  cache.phrase = (lists.phrase || []).map(p => p.toLowerCase());
  cache.word = (lists.word || []).map(w => w.toLowerCase());
  cache.loadedAt = Date.now();
};

exports.isBlockedIp = async function (ip) {
  if (!ip) return false;
  const lists = await ensureLoaded();
  return lists.ip.has(ip);
};

// Synchronous variant for the request-path middleware, which cannot afford to await on
// every request. Reads whatever the cache holds; the refresh is triggered separately at
// startup and on a timer in app.js.
exports.isBlockedIpSync = function (ip) {
  return !!ip && cache.ip.has(ip);
};

exports.isBlockedEmail = async function (email) {
  if (!email) return false;
  const lists = await ensureLoaded();
  return lists.email.has(String(email).trim().toLowerCase());
};

// Returns the matching term (useful for the log) or null.
exports.matchBlockedText = async function (text) {
  if (!text) return null;
  const lists = await ensureLoaded();
  const haystack = String(text).toLowerCase();

  for (const phrase of lists.phrase) {
    if (haystack.includes(phrase)) return { kind: 'phrase', value: phrase };
  }
  for (const word of lists.word) {
    // Whole-word only, so "ass" doesn't match "class". The old single hardcoded array
    // conflated substring and whole-word matching, which is why these are separate kinds.
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(haystack)) return { kind: 'word', value: word };
  }
  return null;
};

// --- admin ---

exports.list = async function () {
  return await sql`
    SELECT id, kind, value, note, created_at, created_by, active
    FROM blocked_entry ORDER BY kind ASC, created_at DESC`;
};

exports.add = async function ({ kind, value, note, createdBy }) {
  // The unique index is on (kind, LOWER(value)), so the conflict target must match it
  // exactly — naming the bare columns would not resolve to that index.
  const rows = await sql`
    INSERT INTO blocked_entry (kind, value, note, created_by)
    VALUES (${kind}, ${String(value).trim()}, ${note || null}, ${createdBy || null})
    ON CONFLICT (kind, LOWER(value)) DO UPDATE
      SET active = TRUE, note = COALESCE(EXCLUDED.note, blocked_entry.note)
    RETURNING id`;
  await load();
  return rows[0] && rows[0].id;
};

exports.setActive = async function (id, active) {
  const rows = await sql`
    UPDATE blocked_entry SET active = ${!!active} WHERE id = ${id} RETURNING id`;
  await load();
  return rows;
};

// --- submission log ---

// Fire-and-forget from the request path: a logging failure must never turn a legitimate
// submission into an error, so this swallows its own errors and returns nothing useful.
exports.logSubmission = async function (entry) {
  try {
    await sql`
      INSERT INTO submission_log
        (endpoint, ip, forwarded_for, user_agent, verdict, reason, email, excerpt)
      VALUES (
        ${String(entry.endpoint || '').slice(0, 200)},
        ${entry.ip || null},
        ${(entry.forwardedFor || '').slice(0, 300) || null},
        ${(entry.userAgent || '').slice(0, 300) || null},
        ${entry.verdict},
        ${entry.reason || null},
        ${(entry.email || '').slice(0, 200) || null},
        ${/* 200 characters: enough to recognise a campaign, not a message archive. */
          (entry.excerpt || '').slice(0, 200) || null}
      )`;
  } catch (err) {
    console.error('spamControls: could not log submission:', err.message);
  }
};

exports.recentSubmissions = async function (limit = 100) {
  const capped = Math.min(Number(limit) || 100, 500);
  return await sql`
    SELECT id, created_at, endpoint, ip, forwarded_for, user_agent, verdict, reason,
           email, excerpt
    FROM submission_log ORDER BY created_at DESC LIMIT ${capped}`;
};

// Counts for the admin screen — the answer to "is this 3 a week or 300?", which nothing
// could answer before. Watch the 'validation' reason in particular: a rising count there
// means real people are failing the form, not bots.
exports.submissionStats = async function () {
  return await sql`
    SELECT verdict, reason, count(*)::int AS n,
           count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7,
           count(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last24h
    FROM submission_log
    GROUP BY verdict, reason
    ORDER BY n DESC`;
};
