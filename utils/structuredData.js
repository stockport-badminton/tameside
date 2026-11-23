// JSON-LD for the event pages (and the homepage's upcoming fixtures), built in code.
//
// Ported from Stockport's utils/structuredData.js (6801d52 and before), the event half only.
// This used to be literal JSON in views/header.ejs, interpolated with `<%= %>`, and two
// classes of bug came from that, neither of which fails loudly because invalid JSON-LD is
// simply ignored:
//
//  1. **Invented property names.** `competitor: [{"@type":"SportsTeam", "homeTeam":"Hyde A"}]`
//     (SportsTeam has no `homeTeam`, so the team names were invisible); `location.address`
//     as `{"type":"PostalAddress"}` with no `@`, so the whole address was discarded; `Lat`
//     and `Lng`, which are not schema.org at all.
//  2. **HTML escaping into JSON.** `<%= %>` escapes for HTML, so an apostrophe shipped as
//     `&#39;` and a double quote would have broken the block. JSON.stringify can't.
//
// And header.ejs emitted the event block only when the page title contained "Event", so
// renaming the title (row 3 of the backlog does) would have dropped it silently. The page
// now passes `jsonLd` and header.ejs prints whatever it is given.

const { absoluteUrl, eventPath } = require('./siteUrl');
const { isoDay } = require('./ukDate');

const LEAGUE_NAME = 'Tameside Badminton League';
const LOGO = '/static/images/Logo.png';

// `venue.address` is one freetext column: the segment before the postcode is the locality.
const POSTCODE = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/i;

function parseUkAddress(freetext) {
  if (!freetext) return null;
  const s = String(freetext).trim();
  const m = s.match(POSTCODE);
  // Anything after the postcode is prose (directions), not address.
  const head = (m ? s.slice(0, m.index) : s).replace(/[\s,.]+$/, '');
  const parts = head.split(',').map(p => p.trim()).filter(Boolean);
  const out = { '@type': 'PostalAddress' };
  if (parts.length > 1) {
    out.streetAddress = parts.slice(0, -1).join(', ');
    out.addressLocality = parts[parts.length - 1];
  } else if (parts.length === 1) {
    out.streetAddress = parts[0];
  }
  if (m) out.postalCode = (m[1] + ' ' + m[2]).toUpperCase();
  if (!out.streetAddress && !out.postalCode) return null;
  out.addressCountry = 'GB';
  return out;
}

// Coordinates only inside the league's catchment: a typo'd latitude asserting a venue in
// Cumbria to a "near me" query is worse than no coordinates.
const GEO_BOUNDS = { latMin: 53.2, latMax: 53.7, lngMin: -2.5, lngMax: -1.8 };

function geoOf(lat, lng) {
  const la = Number(lat), ln = Number(lng);
  if (!isFinite(la) || !isFinite(ln) || (la === 0 && ln === 0)) return null;
  if (la < GEO_BOUNDS.latMin || la > GEO_BOUNDS.latMax) return null;
  if (ln < GEO_BOUNDS.lngMin || ln > GEO_BOUNDS.lngMax) return null;
  return { '@type': 'GeoCoordinates', latitude: la, longitude: ln };
}

// The UTC offset in force in London on a calendar day: "+01:00" or "Z". The old markup used
// the server's getTimezoneOffset(), which is 0 on Cloud Run, so summer times went out with
// no offset at all.
function londonOffset(ymd) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${ymd}T12:00:00Z`));
  const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
  const m = name.match(/GMT([+-]\d{2}:\d{2})/);
  if (!m || m[1] === '+00:00' || m[1] === '-00:00') return 'Z';
  return m[1];
}

// "19:00" / "7.30pm" / "8 pm" -> "19:00"; null when there is no time.
function to24h(text) {
  if (!text) return null;
  const s = String(text).trim();
  let m = s.match(/(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)/i);
  if (!m) {
    const h24 = s.match(/^(\d{1,2}):(\d{2})/);
    return h24 ? `${('0' + h24[1]).slice(-2)}:${h24[2]}` : null;
  }
  let h = parseInt(m[1], 10);
  const pm = m[3].toLowerCase() === 'pm';
  if (pm && h < 12) h += 12;
  if (!pm && h === 12) h = 0;
  return `${('0' + h).slice(-2)}:${m[2] || '00'}`;
}

// An ISO instant on the fixture's own (London) day, or the date alone with no start time.
function eventDateTime(date, time) {
  const ymd = isoDay(date);
  const hhmm = to24h(time);
  return hhmm ? `${ymd}T${hhmm}:00${londonOffset(ymd)}` : ymd;
}

// A rearranged fixture's row keeps its old date and a new row carries the new one, so the
// old row is postponed rather than rescheduled.
function eventStatusOf(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'void') return 'https://schema.org/EventCancelled';
  if (/^rearrang/.test(s)) return 'https://schema.org/EventPostponed';
  return 'https://schema.org/EventScheduled';
}

function leagueOrganization() {
  return { '@type': 'SportsOrganization', name: LEAGUE_NAME, url: absoluteUrl('/'), sport: 'Badminton' };
}

// A fixture's /event/ page. `opts.description` replaces the one-line default (the event page
// passes its preview's summary); `opts.image` (absolute) goes before the logo.
function sportsEvent(f, opts = {}) {
  const name = `${f.homeTeam} vs ${f.awayTeam}`;
  const teams = [f.homeTeam, f.awayTeam].map(n => ({ '@type': 'SportsTeam', name: n }));

  const place = { '@type': 'Place' };
  if (f.venueName) place.name = f.venueName;
  const address = parseUkAddress(f.venueAddress);
  if (address) place.address = address;
  const geo = geoOf(f.Lat, f.Lng);
  if (geo) place.geo = geo;
  if (f.venueLink) place.hasMap = f.venueLink;

  const out = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name,
    url: absoluteUrl(eventPath(f)),
    startDate: eventDateTime(f.date, f.startTime),
    sport: 'Badminton',
    description: opts.description || (f.divisionName
      ? `${LEAGUE_NAME} ${f.divisionName} badminton match: ${name}.`
      : `${LEAGUE_NAME} badminton match: ${name}.`),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: eventStatusOf(f.status),
    isAccessibleForFree: true,
    image: opts.image ? [opts.image, absoluteUrl(LOGO)] : [absoluteUrl(LOGO)],
    homeTeam: teams[0],
    awayTeam: teams[1],
    performer: teams,
    // The league runs the fixture; both of these used to be set to the home club.
    organizer: leagueOrganization(),
  };
  const end = f.endTime ? eventDateTime(f.date, f.endTime) : null;
  if (end && end !== out.startDate) out.endDate = end;
  if (Object.keys(place).length > 1) out.location = place;
  return out;
}

// Home > Division 1 results > Hyde A vs Mellor A. `crumbs` is [{ name, path }], innermost last.
function breadcrumbs(crumbs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: absoluteUrl(c.path) })),
  };
}

// For <script type="application/ld+json">: JSON.stringify handles quotes; the one remaining
// hazard inside a script element is a literal `</script>`, so `<` is escaped.
function jsonLd(obj) {
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}

module.exports = {
  parseUkAddress, geoOf, londonOffset, to24h, eventDateTime, eventStatusOf,
  sportsEvent, breadcrumbs, leagueOrganization, jsonLd, LEAGUE_NAME, GEO_BOUNDS,
};
