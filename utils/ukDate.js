// Dates as a UK reader expects them, formatted by hand.
//
// Not toLocaleDateString: its output depends on the ICU data in the running Node ("Sept"
// in current versions), and a public page should not change shape because the base image
// moved. And always in Europe/London: fixture.date is a timestamp holding UK midnight, so
// read with the process's own clock (UTC on Cloud Run) a September fixture is the evening
// before. Intl is used for the numbers only, which do not vary.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric',
});

// { y, m (1-12), d } of the London calendar day `value` falls on.
function londonParts(value) {
  const parts = fmt.formatToParts(new Date(value)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

// The weekday of a calendar day, which is the same everywhere.
const weekday = ({ y, m, d }) => DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

/** "Wednesday 25 November 2026" */
function longDate(value) {
  const p = londonParts(value);
  return `${weekday(p)} ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** "25 Nov 2026" */
function shortDate(value) {
  const p = londonParts(value);
  return `${p.d} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`;
}

/** "2026-11-25" */
function isoDay(value) {
  const p = londonParts(value);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

module.exports = { longDate, shortDate, isoDay, londonParts };
