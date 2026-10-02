// Every superadmin tool, grouped — the /admin hub is built from this list, and the Admin
// dropdown shows only NAV_SHORTLIST plus "All admin tools…".
//
// The dropdown used to list all of them, 23 superadmin tools plus the two every admin has. Unlike Stockport's, ours was
// already reachable at every size (the July viewport fix makes it scroll — see
// test/e2e/nav-viewport.spec.js); the problem was scanning 26 items for the one you want.
// Ported from Stockport (league-site 566234b). The shortlist is chosen from Cloud Run
// request logs, not guessed — see NAV_SHORTLIST.
//
// One list rather than a hand-written page, so a new tool is added in one place;
// test/admin-tools.test.js checks every href here has a GET route in app.js, and that every
// superadmin link the nav used to carry is still somewhere on this page.

const GROUPS = [
  {
    title: 'Results',
    tools: [
      { href: '/admin/scorecard-ocr', label: 'Scorecard OCR', blurb: 'Read a scorecard photo and prefill the entry form.' },
      { href: '/fixture-players', label: 'Fixture Players', blurb: 'Who played in each fixture.' },
      { href: '/admin/lewis', label: 'Lewis Results', blurb: 'Enter and correct Lewis Shield results.' },
    ],
  },
  {
    title: 'Players & teams',
    tools: [
      { href: '/manage-players/club-Aerospace', label: 'Team Management', blurb: 'Every club\'s squads — reorder, move, add and release players.' },
      { href: '/admin/registration-reminders', label: 'Registration Reminders', blurb: 'Which clubs have returned this season\'s registration form; chase the rest.', count: 'formsOutstanding' },
      { href: '/admin/team-registrations', label: 'Team Registration (import returned)', blurb: 'Diff a returned form against the database and apply the changes.' },
      { href: '/forms/team-registration/Aerospace/prefilled', label: 'Team Registration (prefilled)', blurb: 'A club\'s form filled in from its current roster.', newTab: true },
      { href: '/static/docs/Team Registration.pdf', label: 'Team Registration (blank)', blurb: 'The empty form.', newTab: true, staticFile: true },
      { href: '/admin/clubs', label: 'Club Admin', blurb: 'Add and edit clubs.' },
      { href: '/admin/teams', label: 'Team Admin', blurb: 'Teams and their divisions — promote and relegate.' },
      { href: '/admin/link-auth-accounts', label: 'Link Auth0 Accounts', blurb: 'Connect logins to players, so roles take effect.' },
    ],
  },
  {
    title: 'Rules & stats',
    tools: [
      { href: '/admin/missed-three', label: 'Missed Three', blurb: 'Nominated players who have missed three matches (rule 18).', count: 'missedThree' },
      { href: '/played-up-counts', label: 'Played Up Counts', blurb: 'Players who have played up more than twice this season.' },
      { href: '/player-stats', label: 'Individual Stats', blurb: 'Per-player results and ratings.' },
      { href: '/pair-stats', label: 'Pair Stats', blurb: 'How each pairing has done together.' },
      { href: '/players/eloBackfillAdmin', label: 'ELO Backfill', blurb: 'Recalculate ratings from the game history.' },
    ],
  },
  {
    title: 'Social',
    tools: [
      { href: '/admin/social/weekly-tables', label: 'Weekly Tables Post', blurb: 'Saturday\'s league tables — preview the cards and captions.' },
      { href: '/admin/social/weekly-fixtures', label: 'Weekly Fixtures Post', blurb: 'Sunday\'s coming-week fixtures.' },
      { href: '/admin/social/weekly-video', label: 'Weekly Video Post', blurb: 'The weekly results video.' },
    ],
  },
  {
    title: 'Site & email',
    tools: [
      { href: '/admin/homepage-content', label: 'Manage Homepage', blurb: 'News items on the homepage.' },
      { href: '/admin/site-settings', label: 'Site Settings', blurb: 'Site-wide settings.' },
      { href: '/admin/distribution', label: 'Distribution Lists', blurb: 'Email a group of players or officers.' },
      { href: '/admin/spam', label: 'Spam Controls', blurb: 'Block an address, IP or phrase; see what the filters caught.' },
    ],
  },
];

// The superadmin's dropdown, in order, below the two items every admin has (Enter Result,
// Results Detail). Everything else is one click further, on /admin.
//
// From Cloud Run request logs, 2 Sep - 2 Oct 2026, GET 200s: Team Management 98 (22 days),
// Registration Reminders 28 (9), Team Registration import 8 (5), Fixture Players 6 and Pair
// Stats 6 (3 each); everything else 0-5. Missed Three is new that day and takes Pair Stats'
// tied slot. The registration pages are high because it was the start of the season, so
// this is worth re-measuring mid-season rather than treating as settled.
const NAV_SHORTLIST = [
  '/manage-players/club-Aerospace',
  '/admin/registration-reminders',
  '/admin/team-registrations',
  '/admin/missed-three',
  '/fixture-players',
];

const byHref = new Map();
GROUPS.forEach(g => g.tools.forEach(t => byHref.set(t.href, t)));

function shortlist() {
  return NAV_SHORTLIST.map(href => byHref.get(href));
}

module.exports = { GROUPS, NAV_SHORTLIST, shortlist };
