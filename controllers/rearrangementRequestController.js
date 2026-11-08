// Fixture rearrangement requests that arrived by email (BL-04 step 6). Ported from
// Stockport's controllers/rearrangementRequestController.js (league-site 679e460).
//
// Captains and secretaries agree a rearrangement and email the league, usually copying the
// other side in. The results secretary read each one, found the fixture and entered the
// change through the modal on the results page. Now:
//
//   mail to rearrangements@tameside-badminton.co.uk
//     -> Namecheap catch-all -> Resend -> POST /webhooks/resend -> queueFromEmail() below
//     -> GET /admin/rearrangements/:id: the email beside the fixture and new date it points
//        at, with the checks done by eye before (is that their home night? do they already
//        play that day?), and one Apply button
//
// Nothing is applied from the email itself: Apply calls Fixture.rearrangeById with what the
// page shows, which may have been corrected. The confirmation reply to the clubs stays a
// person's job.
//
// Different from Stockport's, as registrations@ is (controllers/playerRequestController.js):
// the sender gate is the list rule, and a refusal is listed on the queue page, never
// forwarded. One consequence: Stockport's queue holds only what the results secretary chose
// to forward, i.e. settled emails; here a captain can write directly, so an email may be a
// proposal the other club has not yet agreed. The page's refusal warning and the person
// pressing Apply are what stand between that and the fixture list.
//
//   GET  /admin/rearrangements                pending (or ?status=done|dismissed)
//   GET  /admin/rearrangements/:id            one email; ?check=1&fixture=&date=&nodate=1&team=
//   POST /admin/rearrangements/:id/apply      fixture, date | nodate=1
//   POST /admin/rearrangements/:id/status     done / dismissed / reopen

const Requests = require('../models/rearrangementRequest');
const Fixture = require('../models/fixture');
const InboundEmail = require('../models/inboundEmail');
const mailer = require('../utils/mailer');
const authz = require('../utils/authz');
const { readRearrangementEmail, propose, weekday } = require('../utils/rearrangementEmail');

const LOCAL = 'rearrangements';
const ADDRESS = `${LOCAL}@tameside-badminton.co.uk`;

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const STATUSES = ['pending', 'done', 'dismissed'];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const badRequest = (message) => httpError(400, message);

function parseId(value, label) {
  const s = String(value == null ? '' : value);
  if (!/^[0-9]{1,9}$/.test(s) || Number(s) < 1) throw badRequest(label + ' must be a positive integer');
  return Number(s);
}
function optionalId(value) {
  return /^[0-9]{1,9}$/.test(String(value || '')) && Number(value) > 0 ? Number(value) : null;
}
function ymdOrNull(value) {
  const s = String(value == null ? '' : value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

const actor = (req) => authz.userEmail(req) || (req.user && req.user.nickname) || 'admin';

// The UK calendar date of an instant. fixture.date holds local midnight, so "is this in the
// past" is a comparison of calendar dates in London, not of instants.
function ukYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date);
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * Queue a Resend email whose sender has already passed the list gate. Returns
 * `{ outcome: 'queued' | 'already-queued', detail }`; throws only for something Resend
 * should retry.
 */
async function queueFromEmail(email) {
  const { clubs, teams } = await Requests.clubsAndTeams();
  const text = email.text && String(email.text).trim() ? String(email.text) : mailer.htmlToText(email.html || '');
  const created = email.created_at ? new Date(email.created_at) : null;
  const reading = readRearrangementEmail({
    text,
    subject: email.subject || '',
    headerFrom: email.from || null,
    receivedYmd: ukYmd(created && !isNaN(created.getTime()) ? created : new Date()),
    clubs,
    teams,
  });
  const { originalFrom, ...stored } = reading;
  const id = await Requests.create({
    messageId: email.message_id || `resend:${email.id}`,
    forwardedBy: email.from || null,
    originalFrom,
    subject: email.subject || '',
    bodyText: text,
    reading: stored,
  });
  if (id === null) return { outcome: 'already-queued' };
  return { outcome: 'queued', detail: `rearrangement request ${id}` };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

exports.list_page = async function (req, res, next) {
  try {
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'pending';
    const [requests, refused] = await Promise.all([Requests.list(status), InboundEmail.refusedFor(ADDRESS)]);
    res.render('admin/rearrangements', {
      static_path: '/static',
      title: 'Rearrangement requests',
      pageDescription: 'Fixture rearrangement emails waiting to be applied',
      useRosterCss: true,
      status,
      requests,
      refused,
      address: ADDRESS,
    });
  } catch (err) {
    next(err);
  }
};

function addressIn(from) {
  const m = String(from || '').match(/[^\s<>"]+@[^\s<>"]+/);
  return m ? m[0].toLowerCase() : null;
}

function officesOf(p) {
  const offices = [];
  if (p.teamCaptain) offices.push('captain' + (p.team ? ' of ' + p.team : ''));
  if (p.matchSecrertary) offices.push('match secretary');
  if (p.clubSecretary) offices.push('club secretary');
  return offices;
}

// What the secretary would check before applying, for the fixture and date on the form.
// Each is a sentence, because the page shows them as they are.
async function checksFor(fixture, newDate, reading, candidates) {
  const warnings = [];
  const mentioned = new Set((reading.dates || []).map(d => d.ymd));
  const moved = candidates.find(o => o.id < fixture.id && o.status === 'rearranged' && mentioned.has(o.date)
    && o.homeTeamId === fixture.homeTeamId && o.awayTeamId === fixture.awayTeamId);
  if (moved) {
    warnings.push('This looks done already: fixture ' + moved.id + ' (' + moved.dayLabel +
      ', the date in the email) was rearranged, and this is probably its replacement.');
  }
  const status = fixture.homeScore != null ? 'played' : (fixture.status || 'outstanding');
  if (!['outstanding', 'rearranging'].includes(status)) {
    const replacement = status === 'rearranged' ? await Requests.replacementOf(fixture) : null;
    warnings.push('This fixture is already ' + status + (replacement
      ? ' — it is now on ' + replacement.dayLabel + ' (fixture ' + replacement.id + ').'
      : '.'));
  }
  if (!newDate) return warnings;

  const [homeDays, clashes, seasonEnd] = await Promise.all([
    Requests.homeWeekdays(fixture.homeTeamId),
    Requests.fixturesOn(newDate, [fixture.homeTeamId, fixture.awayTeamId], fixture.id),
    Requests.seasonEnd(),
  ]);
  if (newDate === fixture.date) warnings.push('That is the date it already has.');
  if (newDate < ukYmd()) warnings.push('That date has passed.');
  if (seasonEnd && newDate > seasonEnd) warnings.push('That is after the season ends (' + seasonEnd + ').');
  const usual = homeDays[0];
  if (usual && usual.dow !== weekday(newDate)) {
    warnings.push(fixture.homeTeam + ' usually play at home on ' + DAY_NAMES[usual.dow] +
      '; ' + newDate + ' is a ' + DAY_NAMES[weekday(newDate)].slice(0, -1) + '.');
  }
  for (const c of clashes) {
    warnings.push('Already on that day: ' + c.homeTeam + ' v ' + c.awayTeam + ' (fixture ' + c.id + ').');
  }
  for (const d of (reading.dates || [])) {
    if (d.ymd === newDate && d.dayMismatch) {
      warnings.push('The email says "' + d.raw + '", but ' + newDate + ' is a ' +
        DAY_NAMES[weekday(newDate)].slice(0, -1) + ' — check which is right.');
      break;
    }
  }
  return warnings;
}

exports.detail_page = async function (req, res, next) {
  try {
    const id = parseId(req.params.id, 'id');
    const request = await Requests.getById(id);
    if (!request) return next(httpError(404, 'No such request'));
    const reading = Object.assign({ dates: [], clubIds: [], teamIds: [] }, request.reading || {});

    const [{ clubs, teams }, senders] = await Promise.all([
      Requests.clubsAndTeams(),
      Requests.playersByEmail(addressIn(request.originalFrom || request.forwardedBy)),
    ]);
    const senderClubIds = [...new Set(senders.map(p => p.clubId).filter(Boolean))];
    const teamId = optionalId(req.query.team);
    const candidates = await Requests.candidateFixtures({
      dates: [...new Set(reading.dates.map(d => d.ymd))],
      clubIds: [...new Set([...reading.clubIds, ...senderClubIds])],
      teamId,
    });
    const proposal = propose(reading, candidates, senderClubIds);
    const order = new Map(proposal.ranked.map((fid, i) => [fid, i]));
    candidates.sort((a, b) => order.get(a.id) - order.get(b.id));

    // What the form shows: the query when Check was pressed (or Apply was refused), else
    // what was applied, else the proposal.
    const outcome = request.outcome;
    const checking = req.query.check === '1';
    const fixtureId = checking ? optionalId(req.query.fixture)
      : outcome ? outcome.fixtureId : proposal.fixtureId;
    const noDate = checking ? req.query.nodate === '1'
      : outcome ? outcome.action === 'rearranging' : !proposal.newDate;
    const newDate = noDate ? null
      : checking ? ymdOrNull(req.query.date) : outcome ? outcome.date : proposal.newDate;

    let selected = fixtureId ? candidates.find(c => c.id === fixtureId) : null;
    if (fixtureId && !selected) {
      selected = await Requests.fixtureById(fixtureId);
      if (selected) candidates.unshift(selected);
    }
    const warnings = selected ? await checksFor(selected, newDate, reading, candidates) : [];
    if (reading.refused) warnings.unshift('The email may be declining the rearrangement ("unable to…"). Read it before applying.');

    res.render('admin/rearrangement', {
      static_path: '/static',
      title: 'Rearrangement request',
      pageDescription: 'Confirm one fixture rearrangement email',
      useRosterCss: true,
      request,
      reading,
      clubNames: new Map(clubs.map(c => [c.id, c.name])),
      teams,
      teamId,
      senders: senders.map(p => ({ name: p.firstName + ' ' + p.familyName, club: p.club, offices: officesOf(p) })),
      candidates,
      selectedId: selected ? selected.id : null,
      newDate,
      noDate,
      proposedFixtureId: proposal.fixtureId,
      warnings,
      outcome,
      applied: !!req.query.applied,
      error: req.query.error ? String(req.query.error).slice(0, 200) : null,
    });
  } catch (err) {
    next(err);
  }
};

exports.apply = async function (req, res, next) {
  const body = req.body || {};
  let id;
  try {
    id = parseId(req.params.id, 'id');
    const fixtureId = parseId(body.fixture, 'fixture');
    const noDate = body.nodate === '1';
    const date = noDate ? null : ymdOrNull(body.date);
    if (!noDate && !date) throw badRequest('Give the new date, or tick "no date agreed yet"');

    const by = actor(req);
    await Fixture.rearrangeById(fixtureId, date, async (tx, result) => {
      const recorded = await Requests.recordOutcome(tx, id, {
        action: result.action, fixtureId: result.fixtureId,
        replacementId: result.replacementId, date: result.date || null,
      }, by);
      // Closed already (another tab, or a dismissed request): undo the fixture change too.
      if (!recorded) throw httpError(409, 'This request is not pending');
    });
    res.redirect('/admin/rearrangements/' + id + '?applied=1');
  } catch (err) {
    // A refusal the page can explain ("fixture 7124 is already rearranged") goes back to it,
    // with the form as it was submitted; anything else is a 500.
    if (id && err.status >= 400 && err.status < 500) {
      const back = new URLSearchParams({
        check: '1',
        fixture: String(body.fixture || ''), date: String(body.date || ''),
        nodate: body.nodate === '1' ? '1' : '', error: String(err.message).slice(0, 200),
      });
      return res.redirect(303, '/admin/rearrangements/' + id + '?' + back);
    }
    next(err);
  }
};

exports.set_status = async function (req, res, next) {
  try {
    const id = parseId(req.params.id, 'id');
    const status = String((req.body && req.body.status) || '');
    if (!STATUSES.includes(status)) throw badRequest('status must be one of ' + STATUSES.join(', '));
    const ok = await Requests.setStatus(id, status, actor(req));
    if (!ok) return next(httpError(404, 'No such request'));
    res.redirect(status === 'pending' ? '/admin/rearrangements/' + id : '/admin/rearrangements');
  } catch (err) {
    next(err);
  }
};

exports.LOCAL = LOCAL;
exports.ADDRESS = ADDRESS;
exports.queueFromEmail = queueFromEmail;
