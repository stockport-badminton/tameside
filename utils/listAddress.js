// Which league list an inbound email was for, and whether to believe who sent it.
// Pure: no DB, no network. controllers/inboundEmailController.js does the I/O.
//
// See docs/backlog/BL-04-inbound-email-resend.md for the whole design. The short version:
// list addresses COMBINE a club, a division and a role, as Stockport's do (`division1@`,
// `hyde@`, `teamcaptains@`, `hydeteamcaptains@`, `division1teamcaptains@`), and are resolved
// here rather than kept as one Namecheap forward each.

const DOMAIN = 'tameside-badminton.co.uk';

// Local-part word -> the `role` value Player.getEmails filters on. `leaguecomms` is
// Stockport's name for the otherComms flag, kept so the two sites' addresses match.
const ROLES = {
  teamcaptains: 'team Captain',
  clubsecretaries: 'club Sec',
  matchsecretaries: 'match Sec',
  treasurers: 'treasurer',
  leaguecomms: 'otherComms',
};

// `G.H.A.P` -> `ghap`, `Division 1` -> `division1`, `Manchester Edgeley` ->
// `manchesteredgeley`. The same punctuation-blind comparison registrationDiff uses for club
// names, because the club row and its teams disagree about the dots.
function normalise(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Resend's `headers` is an object. A header that appears once is a string; one that appears
// several times is a JSON-encoded array, TOPMOST FIRST (measured on `received`, 7 Nov 2026).
function headerValues(headers, name) {
  const raw = headers && headers[name];
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String);
  const s = String(raw);
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (e) { /* a value that merely starts with "[" */ }
  }
  return [s];
}

// `"Name" <a@b.com>`, `<a@b.com>` or `a@b.com` -> `a@b.com`, lower-cased. null if none.
function extractAddress(value) {
  if (!value) return null;
  const s = String(value);
  const angled = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angled ? angled[1] : (s.match(/[^\s<>"',;]+@[^\s<>"',;]+/) || [])[0];
  return bare ? bare.toLowerCase() : null;
}

// The display name in `"Neil Cooper" <a@b.com>`, or null.
function extractName(value) {
  if (!value) return null;
  const m = String(value).match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  return m && m[1].trim() ? m[1].trim() : null;
}

/**
 * The league address this copy of the message was delivered for.
 *
 * After the forward, the envelope recipient is `inbound@<id>.resend.app` for every list, so
 * the list has to come from what Namecheap's forwarder recorded: Gate 0 (7 Nov 2026) found
 * it adds `X-Original-To: <list@…>` for To, Cc and Bcc alike.
 *
 * Only the TOPMOST X-Original-To, the one Namecheap added. Anything lower down was written
 * by the sender and can be forged, and a forged one would also show up in `received_for`
 * (Resend reads that from every `Received: … for <…>` line). So the topmost one must be ours
 * AND appear in `received_for`; agreeing with each other is what makes it believable.
 *
 * @returns {{ address: string, local: string } | null}
 */
function leagueAddress(email) {
  const top = extractAddress(headerValues(email && email.headers, 'x-original-to')[0]);
  if (!top || !top.endsWith('@' + DOMAIN)) return null;
  const receivedFor = ((email && email.received_for) || []).map(a => String(a).toLowerCase());
  if (!receivedFor.includes(top)) return null;
  return { address: top, local: top.slice(0, -(DOMAIN.length + 1)) };
}

/**
 * The words a local part may be built from, from the database.
 *
 * @param {{ divisions: {id, name}[], clubs: {id, name}[] }} rows  clubs WITHOUT No Club
 */
function buildVocabulary({ divisions = [], clubs = [] }) {
  const words = new Map();
  const add = (kind, word, value, label) => {
    if (!word) return;
    // A word that means two things means nothing: two clubs normalising alike, or a club
    // named like a role. Neither exists today; if one ever does, it matches no list.
    if (words.has(word)) { words.set(word, null); return; }
    words.set(word, { kind, value, label });
  };
  for (const d of divisions) add('division', normalise(d.name), Number(d.id), d.name);
  for (const c of clubs) add('club', normalise(c.name), Number(c.id), c.name);
  for (const [word, role] of Object.entries(ROLES)) add('role', word, role, word);
  return words;
}

/**
 * Parse a local part into `{ division?, club?, role? }`, each at most once, in any order.
 *
 * EXACT, unlike Stockport's. Theirs asks `indexOf` of each word, so any address containing
 * "dome" means Dome, and a typo or a spammer's guess still reaches a real list. This one
 * must consume the WHOLE local part, so `hydex@`, `xhyde@` and `hydetest@` match nothing.
 * If more than one reading consumes it, that is ambiguous and also matches nothing.
 *
 * @returns {{ division?: number, club?: number, role?: string, label: string } | null}
 */
function parseLocalPart(local, vocab) {
  const s = normalise(local);
  if (!s || s !== String(local).toLowerCase()) return null;   // dots, plus-tags: not a list
  const parses = [];
  const walk = (rest, found) => {
    if (parses.length > 1) return;
    if (!rest) { if (Object.keys(found).length) parses.push(found); return; }
    for (const [word, meaning] of vocab) {
      if (!meaning || found[meaning.kind] || !rest.startsWith(word)) continue;
      walk(rest.slice(word.length), { ...found, [meaning.kind]: meaning });
    }
  };
  walk(s, {});
  if (parses.length !== 1) return null;
  const p = parses[0];
  const out = { label: s };
  if (p.division) out.division = p.division.value;
  if (p.club) out.club = p.club.value;
  if (p.role) out.role = p.role.value;
  return out;
}

/**
 * Is the From address genuinely the sender's? From Resend's top-level `authentication`
 * only; Namecheap's own Authentication-Results header is in the message too, and ignored.
 *
 * SPF PROVES NOTHING HERE. After the Namecheap forward, SPF is checked against Namecheap's
 * forwarder, which our own SPF record includes, so a pass is a pass for us. Stockport's
 * registrations@ accepts `dkim || spf`, and copying it would let anything through.
 *
 * DKIM alone is not enough either: anyone can DKIM-sign mail with their own domain and put
 * a captain's address in From. DMARC is the check that the signature belongs to the From
 * domain. So: DMARC pass; or, for a domain that publishes no DMARC policy at all (so DMARC
 * cannot pass), a DKIM pass. A DMARC FAIL is refused whatever DKIM says.
 */
function isGenuineSender(auth) {
  const a = auth || {};
  const dmarc = String(a.dmarc || '').toLowerCase();
  const dkim = String(a.dkim || '').toLowerCase();
  if (dmarc === 'pass') return true;
  if (dmarc === 'fail') return false;
  return dkim === 'pass';
}

// Ours, coming back round: every forward carries our List-Id. Or a message sent from the
// Resend receiving domain itself, which nobody should be doing.
function isLoop(email, inboundDomain) {
  if (headerValues(email && email.headers, 'list-id').some(v => v.toLowerCase().includes('.' + DOMAIN))) return true;
  const from = extractAddress(email && email.from);
  return !!(inboundDomain && from && from.endsWith('@' + String(inboundDomain).toLowerCase()));
}

// "test" as a WORD in the subject sends only to the results mailbox, with the resolved
// recipients listed, as Stockport's does. Theirs is `indexOf('test')`, which a subject
// saying "latest" or "contest" would also trip.
function isTestSubject(subject) {
  return /\btest\b/i.test(String(subject || ''));
}

module.exports = {
  DOMAIN,
  ROLES,
  normalise,
  headerValues,
  extractAddress,
  extractName,
  leagueAddress,
  buildVocabulary,
  parseLocalPart,
  isGenuineSender,
  isLoop,
  isTestSubject,
};
