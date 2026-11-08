// Player registration requests that arrived by email (BL-04 step 6). Ported from
// Stockport's controllers/playerRequestController.js (league-site 90cb07f).
//
// Registrations come in as email, from club secretaries, captains and the players
// themselves, often several to a message, and were handled by reading each name out and
// typing it into the roster editor. Now:
//
//   mail to registrations@tameside-badminton.co.uk
//     -> Namecheap catch-all -> Resend -> POST /webhooks/resend -> queueFromEmail() below
//     -> GET /admin/player-requests: the email beside the names read out of it, each
//        already matched against the players on file, one button per person
//
// Nothing is applied from the email itself. The page's buttons call the roster API the
// roster editor uses (/api/roster/club-:club/players and /transfer), so there is still one
// way to create or move a player, with one set of checks, and this file only records which
// button was pressed for whom.
//
// Different from Stockport's, on purpose:
//   - WHO MAY FILL THE QUEUE is the list rule (inboundEmailController): a known sender whose
//     From is authenticated. Theirs is an allowlist of the addresses the results secretary
//     forwards from, plus `dkim || spf`, and SPF proves nothing after our Namecheap forward.
//     So a club secretary can write to registrations@ directly, not only through a forward.
//   - A REFUSAL IS NOT FORWARDED. Theirs falls back to forwarding to the results inbox; here
//     nothing unrecognised is relayed through Mailjet, so a refusal is listed on the queue
//     page instead, where a real secretary who was refused can be seen.
//
//   GET  /admin/player-requests                     pending (or ?status=done|dismissed)
//   GET  /admin/player-requests/match?q=&gender=    re-match an edited name
//   GET  /admin/player-requests/:id                 one email, worked through
//   POST /admin/player-requests/:id/candidates/:i   record the outcome for one person
//   POST /admin/player-requests/:id/candidates      add a person the reading missed
//   POST /admin/player-requests/:id/status          done / dismissed / reopen

const Requests = require('../models/registrationRequest');
const Roster = require('../models/roster');
const InboundEmail = require('../models/inboundEmail');
const mailer = require('../utils/mailer');
const authz = require('../utils/authz');
const { parseRegistrationEmail } = require('../utils/registrationEmail');

const LOCAL = 'registrations';
const ADDRESS = `${LOCAL}@tameside-badminton.co.uk`;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const badRequest = (message) => httpError(400, message);

function parseIndex(value, label) {
  const s = String(value == null ? '' : value);
  if (!/^[0-9]{1,6}$/.test(s)) throw badRequest(label + ' must be a non-negative integer');
  return Number(s);
}

const actor = (req) => authz.userEmail(req) || (req.user && req.user.nickname) || 'admin';

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * Queue a Resend email whose sender has already passed the list gate. Returns
 * `{ outcome: 'queued' | 'already-queued', detail }`; throws only for something Resend
 * should retry.
 */
async function queueFromEmail(email) {
  const teams = await Requests.registrableTeams();
  const text = email.text && String(email.text).trim() ? String(email.text) : mailer.htmlToText(email.html || '');
  const parsed = parseRegistrationEmail({
    text,
    headerFrom: email.from || null,
    teamNames: teams.map(t => t.name),
  });
  const candidates = parsed.candidates.map(c => ({
    first: c.first, family: c.family, gender: c.gender, team: c.team, raw: c.raw,
    outcome: null, playerId: null,
  }));
  const id = await Requests.create({
    messageId: email.message_id || `resend:${email.id}`,
    forwardedBy: email.from || null,
    originalFrom: parsed.originalFrom,
    subject: email.subject || '',
    bodyText: text,
    // Names only. An attached spreadsheet or registration form is not read here: the page
    // says it exists, so it is opened from the original email rather than missed.
    attachments: (email.attachments || [])
      .filter(a => a && a.content_disposition !== 'inline')
      .map(a => a.filename || '(unnamed attachment)'),
    candidates,
  });
  if (id === null) return { outcome: 'already-queued' };
  return { outcome: 'queued', detail: `registration request ${id}, ${candidates.length} people read` };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const STATUSES = ['pending', 'done', 'dismissed'];

function summarise(candidates) {
  const all = Array.isArray(candidates) ? candidates : [];
  return { total: all.length, handled: all.filter(c => c && c.outcome).length };
}

exports.list_page = async function (req, res, next) {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    const [rows, refused] = await Promise.all([
      Requests.list(status),
      InboundEmail.refusedFor(ADDRESS),
    ]);
    res.render('admin/player-requests', {
      static_path: '/static',
      title: 'Registration requests',
      pageDescription: 'Registration emails waiting to be processed',
      useRosterCss: true,
      status,
      requests: rows.map(r => Object.assign({}, r, summarise(r.candidates))),
      refused,
      address: ADDRESS,
    });
  } catch (err) {
    next(err);
  }
};

// Best matches first regardless of where the player is; `where` tells the page what the
// action means. Gender filters only when it is known: an email that did not say is exactly
// when the other-gender namesake is worth seeing.
function flatten(found, gender) {
  const tag = where => p => Object.assign({ where }, p);
  return [].concat(found.unattached.map(tag('unattached')), found.otherClubs.map(tag('club')))
    .filter(p => !gender || p.gender === gender)
    .sort((a, b) => rank(a.match) - rank(b.match))
    .slice(0, 6);
}
function rank(kind) {
  return kind === 'exact' ? 0 : kind === 'contains' ? 1 : 2;
}

exports.detail_page = async function (req, res, next) {
  try {
    const id = parseIndex(req.params.id, 'id');
    const request = await Requests.getById(id);
    if (!request) return next(httpError(404, 'No such request'));
    const [teams, table] = await Promise.all([Requests.registrableTeams(), Roster.allForMatching()]);
    // One read of the player table, matched per person, so the page arrives with every
    // "is this someone we already have?" answered.
    const candidates = (request.candidates || []).map(c => {
      const found = Roster.splitCandidates(table, c.first + ' ' + c.family, null);
      return Object.assign({}, c, { matches: flatten(found, c.gender) });
    });
    res.render('admin/player-request', {
      static_path: '/static',
      title: 'Registration request',
      pageDescription: 'Work through one registration email',
      useRosterCss: true,
      request,
      candidates,
      teams,
    });
  } catch (err) {
    next(err);
  }
};

exports.api_match = async function (req, res, next) {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ matches: [] });
    const gender = req.query.gender === 'Male' || req.query.gender === 'Female' ? req.query.gender : null;
    const found = Roster.splitCandidates(await Roster.allForMatching(), q, null);
    res.json({ matches: flatten(found, gender) });
  } catch (err) {
    next(err);
  }
};

// The page sends the whole edited candidate, having already done the roster write.
function cleanCandidate(body) {
  const b = body || {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const outcome = b.outcome == null || b.outcome === '' ? null : String(b.outcome);
  if (outcome !== null && !Requests.OUTCOMES.includes(outcome)) {
    throw badRequest('outcome must be one of ' + Requests.OUTCOMES.join(', '));
  }
  const playerId = b.playerId == null || b.playerId === '' ? null : Number(b.playerId);
  if (playerId !== null && !(Number.isInteger(playerId) && playerId > 0)) throw badRequest('playerId must be a positive integer');
  const first = str(b.first, 60);
  const family = str(b.family, 60);
  if (!first || !family) throw badRequest('Both a first name and a family name are needed');
  return {
    first,
    family,
    gender: b.gender === 'Male' || b.gender === 'Female' ? b.gender : null,
    team: str(b.team, 80) || null,
    raw: str(b.raw, 200),
    outcome,
    playerId,
  };
}

exports.api_set_candidate = async function (req, res, next) {
  try {
    const id = parseIndex(req.params.id, 'id');
    const index = parseIndex(req.params.index, 'index');
    const candidates = await Requests.setCandidate(id, index, cleanCandidate(req.body));
    if (!candidates) return next(httpError(404, 'No such request or person'));
    res.json({ ok: true, candidates, summary: summarise(candidates) });
  } catch (err) {
    next(err);
  }
};

exports.api_add_candidate = async function (req, res, next) {
  try {
    const id = parseIndex(req.params.id, 'id');
    const candidate = cleanCandidate(Object.assign({}, req.body, { outcome: null, playerId: null, raw: 'added by hand' }));
    const candidates = await Requests.appendCandidate(id, candidate);
    if (!candidates) return next(httpError(404, 'No such request'));
    res.json({ ok: true, index: candidates.length - 1, candidates });
  } catch (err) {
    next(err);
  }
};

exports.set_status = async function (req, res, next) {
  try {
    const id = parseIndex(req.params.id, 'id');
    const status = String((req.body && req.body.status) || '');
    if (!STATUSES.includes(status)) throw badRequest('status must be one of ' + STATUSES.join(', '));
    const ok = await Requests.setStatus(id, status, actor(req));
    if (!ok) return next(httpError(404, 'No such request'));
    // Back to the queue once something is closed; back to the request when reopened.
    res.redirect(status === 'pending' ? '/admin/player-requests/' + id : '/admin/player-requests');
  } catch (err) {
    next(err);
  }
};

exports.LOCAL = LOCAL;
exports.ADDRESS = ADDRESS;
exports.queueFromEmail = queueFromEmail;
