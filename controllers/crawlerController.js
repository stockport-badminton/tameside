// robots.txt, sitemap.xml and llms.txt — the three files crawlers and AI assistants read
// before (or instead of) the pages. All generated per request, because what they describe
// changes with the routes and the data, not with a release. Each is cached for an hour:
// Firebase's CDN honours that and has no purge, and Stockport found a day-long max-age
// kept the edge serving yesterday's sitemap after a deploy that added pages.
//
// They replaced rootfiles/robots.txt (a 3,548-line copied blocklist that opted the site
// out of Common Crawl) and rootfiles/sitemap.xml (11 hand-written URLs from 2018).

const Fixture = require('../models/fixture');
const Division = require('../models/division');
const Club = require('../models/club');
const seasonModel = require('../models/season');
const robots = require('../utils/robots');
const { absoluteUrl, eventPath, divisionSlug, divisionResultsPath, divisionTablePath } = require('../utils/siteUrl');

const HOUR = 'public, max-age=3600';

// These models are async functions that ALSO take a callback; util.promisify warns on
// that (DEP0174), so they are wrapped by hand.
function viaCallback(fn) {
  return new Promise((resolve, reject) => fn((err, rows) => (err ? reject(err) : resolve(rows))));
}

exports.robots = function (req, res) {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', HOUR);
  res.send(robots.renderRobots(req.app));
};

// ---------------------------------------------------------------------------------------
// GET /sitemap.xml — ported from Stockport's controllers/sitemapController.js.
//
// Only public HTML pages. Not here, on purpose:
//   - anything behind a login (robots.txt disallows those; listing one is a wasted crawl)
//   - /teams, /clubs, /fixtures/*: they answer JSON
//   - player stats pages: behind a login since Nov 2026, so covered by the first rule
//   - past seasons' event pages: they 404 (getFixtureEventById's joins, models/fixture.js)

const STATIC_PATHS = [
  '/',
  '/info/clubs',
  '/rules',
  '/history',
  '/lewis-shield',
  '/contact-us',
  '/privacy-policy',
  '/tables/All',
  '/results/All',
  '/results-grid/All',
];

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// <lastmod> only where it is true: a played fixture's page stops changing with its result.
// No <changefreq>/<priority>; Google ignores both.
function urlEntry(path, lastmod) {
  return '  <url><loc>' + xmlEscape(absoluteUrl(path)) + '</loc>'
    + (lastmod ? '<lastmod>' + lastmod + '</lastmod>' : '') + '</url>';
}

function localDay(date) {
  const d = new Date(date);
  if (isNaN(d)) return null;
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

async function sitemapPaths() {
  const [divisions, seasons, fixtures] = await Promise.all([
    viaCallback(Division.getAll),
    seasonModel.getAll(),
    Fixture.getForSitemap(),
  ]);
  const entries = STATIC_PATHS.map((p) => [p]);
  for (const d of divisions) {
    entries.push([divisionTablePath(d.name)], [divisionResultsPath(d.name)],
      ['/results-grid/' + divisionSlug(d.name)]);
  }
  // Archived seasons: the All views only. Season.getAll returns only seasons with a
  // snapshot behind them, and division names have changed over the years.
  for (const s of seasons) {
    entries.push([divisionTablePath('All', s.name)], [divisionResultsPath('All', s.name)]);
    if (s.hasLewis) entries.push(['/lewis-shield/' + encodeURIComponent(s.name)]);
  }
  for (const f of fixtures) {
    const played = f.status === 'complete' || f.status === 'conceded';
    entries.push([eventPath(f), played ? localDay(f.date) : null]);
  }
  return entries;
}

exports.sitemap = async function (req, res, next) {
  try {
    const entries = await sitemapPaths();
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', HOUR);
    res.send('<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + entries.map(([p, lastmod]) => urlEntry(p, lastmod)).join('\n')
      + '\n</urlset>\n');
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------------------
// GET /llms.txt — the llmstxt.org convention: a short Markdown guide to the site for a
// language model, so it can answer "where does Hyde play?" without parsing the pages.
// Built from the same club query as /info/clubs, so it cannot drift from what the site
// says. Only facts the database or the league holds; nothing here is marketing.

function seasonLabel(name) {
  const m = /^(\d{4})(\d{4})$/.exec(String(name || ''));
  return m ? m[1] + '/' + m[2].slice(2) : String(name || '');
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// clubDetail is one row per club and team; keep the first row per club, minus the
// placeholder club where unregistered players are parked.
function clubsFrom(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (r.name === 'No Club' || seen.has(r.clubId)) continue;
    seen.set(r.clubId, r);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

exports.llms = async function (req, res, next) {
  try {
    const [rows, divisions] = await Promise.all([
      viaCallback(Club.clubDetail),
      viaCallback(Division.getAll),
    ]);
    const clubs = clubsFrom(rows || []);
    const season = seasonLabel(seasonModel.current());
    const link = (label, path, what) => '- [' + label + '](' + absoluteUrl(path) + '): ' + what;

    const lines = [
      '# Tameside Badminton League',
      '',
      '> An amateur inter-club badminton league for clubs in and around Tameside, Greater '
        + 'Manchester, England. The ' + season + ' season has '
        + divisions.length + ' divisions (' + divisions.map((d) => d.name).join(', ') + ') and '
        + clubs.length + ' member clubs. Matches are played September to April.',
      '',
      'Each match is between two teams of four men and two women and is made up of 18 games; '
        + 'the match score is the number of games each team won. Results, tables and fixtures '
        + 'on this site are updated as scorecards are submitted.',
      '',
      '## Current season',
      '',
      link('League tables', divisionTablePath('All'), 'standings for every division'),
      ...divisions.map((d) => link(d.name + ' table', divisionTablePath(d.name), d.name + ' standings')),
      link('Fixtures and results', divisionResultsPath('All'), 'every match this season, played and to come, with scores'),
      link('Results grid', '/results-grid/All', 'each division as a home-and-away grid'),
      link('Fixture calendar', '/calendars/All', 'iCalendar feed of every fixture'),
      link('Lewis Shield', '/lewis-shield', 'the league\'s knockout cup'),
      '',
      '## Clubs',
      '',
      'Club nights and venues, and where each team plays its matches: ' + absoluteUrl('/info/clubs'),
      '',
      ...clubs.map((c) => '- **' + oneLine(c.name) + '**: club night ' + oneLine(c.clubNightText)
        + (c.clubvenue ? ' at ' + oneLine(c.clubvenue) : '')
        + (c.clubaddress ? ' (' + oneLine(c.clubaddress) + ')' : '')
        + (c.clubWebsite ? '. Website: ' + oneLine(c.clubWebsite) : '')),
      '',
      '## About the league',
      '',
      link('Rules', '/rules', 'the league\'s competition rules'),
      link('History', '/history', 'final tables from past seasons'),
      link('Contact', '/contact-us', 'how to reach the league\'s officers'),
      '',
      '## Optional',
      '',
      link('Sitemap', '/sitemap.xml', 'every public page, including one per fixture'),
      link('Privacy policy', '/privacy-policy', 'what the site collects'),
    ];

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', HOUR);
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    next(err);
  }
};

exports._sitemapPaths = sitemapPaths;
