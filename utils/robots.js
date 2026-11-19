// GET /robots.txt, built from the route table rather than written by hand.
//
// The rule: anything that needs a login (or a token, or is dev-only) is not for crawlers.
// Every route already declares who may call it as its first middleware
// (middleware/access.js), so the Disallow list is DERIVED from those declarations: add a
// `member` route and it is disallowed without anyone remembering to edit this file. The
// test (test/integration/crawlers.test.js) checks both directions against the real router:
// every non-public GET is blocked, and no public GET is blocked by accident.
//
// What it replaced (Nov 2026): a 3,548-line per-bot blocklist copied in Feb 2025, with no
// `User-agent: *` group and no Sitemap line. Among its ~1,700 entries was CCBot — Common
// Crawl, one of the main corpora AI models are trained on — so the league was opted out of
// exactly the thing that gets it known to ChatGPT, Claude and friends. The rest were SEO
// scrapers that ignore robots.txt anyway, and a blocklist doesn't stop a bot that ignores it.
//
// Why wildcards, not prefixes. Robots rules are prefix matches, and a route's literal
// prefix is often shared with a public route: `/player/:id/update` needs a login, but
// `/player/:id` is public, so `Disallow: /player/` would hide every player page. Each
// parameter becomes `*` instead (`/player/*/update`). `*` and `$` are in RFC 9309 and
// honoured by Google, Bing, OpenAI, Anthropic and Common Crawl.
//
// `X-Robots-Tag: noindex` on the same responses is the other half — see access.js.

const { routeTable } = require('./routeTable');
const { absoluteUrl } = require('./siteUrl');

// Public routes that are still not worth a crawl, with the reason. Everything else that
// is disallowed comes from the route table.
const EXTRA_DISALLOW = [
  ['/login', 'starts the Auth0 round trip'],
  ['/callback', 'Auth0 returns here'],
  ['/logout', 'ends a session'],
  ['/api/', 'JSON for the pages\' own scripts, not pages'],
];

// Named on purpose, so it is obvious from the file that they are welcome. They share the
// `*` group's rules (consecutive User-agent lines form one group), so nothing has to be
// restated per bot.
const WELCOME = [
  'Googlebot', 'Bingbot', 'Applebot', 'DuckDuckBot',
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'CCBot',
];

// An Express path pattern as a robots rule: each parameter is `*`, and trailing wildcards
// are dropped because a rule is already a prefix match.
function ruleFor(routePath) {
  if (typeof routePath !== 'string') {
    throw new Error('robots: cannot derive a rule from a non-string route path ' + routePath);
  }
  return routePath
    .replace(/:\w+(\([^)]*\))?\??/g, '*')
    .replace(/\*+/g, '*')
    .replace(/(\/?\*)+$/, (m) => (m.startsWith('/') ? '/' : ''));
}

// A rule with no wildcard covers every rule that starts with it.
function collapse(rules) {
  const sorted = [...new Set(rules)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept = [];
  for (const r of sorted) {
    if (!kept.some((k) => !k.includes('*') && r.startsWith(k))) kept.push(r);
  }
  return kept.sort();
}

function disallowRules(app) {
  const gated = routeTable(app)
    .filter((r) => r.method === 'GET' && r.access && r.access !== 'public')
    .map((r) => ruleFor(r.path));
  return collapse([...gated, ...EXTRA_DISALLOW.map(([p]) => p)]);
}

// RFC 9309 matching, Disallow-only: does any rule match the start of the url?
function isDisallowed(rules, url) {
  return rules.some((rule) => {
    const anchored = rule.endsWith('$');
    const body = (anchored ? rule.slice(0, -1) : rule)
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp('^' + body + (anchored ? '$' : '')).test(url);
  });
}

function renderRobots(app) {
  const lines = [
    '# Tameside Badminton League. Generated from the route table (utils/robots.js):',
    '# everything that needs a login is disallowed, everything public is open.',
    '# A plain-text guide to the site for language models: ' + absoluteUrl('/llms.txt'),
    '',
    ...WELCOME.map((ua) => 'User-agent: ' + ua),
    'User-agent: *',
    ...disallowRules(app).map((r) => 'Disallow: ' + r),
    '',
    'Sitemap: ' + absoluteUrl('/sitemap.xml'),
  ];
  return lines.join('\n') + '\n';
}

module.exports = { ruleFor, collapse, disallowRules, isDisallowed, renderRobots, EXTRA_DISALLOW };
