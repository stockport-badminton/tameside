// Deploys run automatically on push to main (Cloud Build trigger → cloudbuild.yaml).
// To re-run the same build+deploy pipeline by hand, see Readme.md.

// Sentry instrumentation — must load before express and other modules so Sentry
// can auto-instrument them. No-op unless SENTRY_DSN is set (see instrument.js).
require('./instrument');
const Sentry = require('@sentry/node');

// Registered straight after Sentry so an unhandled rejection from one of the many
// unguarded async model callbacks fails that request instead of killing the container.
// Production already survives these, but only because Sentry's own listener happens to
// be registered — see utils/processGuards.js for the measurements.
require('./utils/processGuards').install();

require('dotenv').config()
const express = require('express')
const session = require('express-session');
const passport = require('passport');
const Auth0Strategy = require('passport-auth0');
const bodyParser = require('body-parser');
const compression = require('compression');
const {check, validationResult} = require('express-validator')
let { expressjwt: jwt } = require("express-jwt");
let jwksRsa = require('jwks-rsa');
let sassMiddleware = require('express-dart-sass')
let path = require('path')
const {
  PutObjectCommand,
} = require ("@aws-sdk/client-s3");
const { getSignedUrl } = require ("@aws-sdk/s3-request-presigner");
// One place that knows which credentials actually work — see utils/s3.js.
const { s3Client } = require('./utils/s3');
const { title } = require('process');
const { appendFile } = require('fs/promises');

if (!process.env.AUTH0_DOMAIN || !process.env.AUTH0_AUDIENCE) {
    throw 'Make sure you have AUTH0_DOMAIN, and AUTH0_AUDIENCE in your .env file';
}

// Authentication middleware. When used, the
    // Access Token must exist and be verified against
    // the Auth0 JSON Web Key Set
    const checkJwt = jwt({
        // Dynamically provide a signing key
        // based on the key in the header and
        // the signing keys provided by the JWKS endpoint.
        secret: jwksRsa.expressJwtSecret({
          cache: true,
          rateLimit: true,
          jwksRequestsPerMinute: 5,
          jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`
        }),
  
        // Validate the audience and the issuer.
        algorithms: ['RS256']
      });

const app = express()
const port = 8080

// Whether views/pwa-head.ejs registers the service worker.
//
// Off outside production on purpose. sw.js caches /static/** cache-first, keyed on
// CACHE_VERSION = 'tameside-static-' + K_REVISION (see the /sw.js route below).
// K_REVISION only exists on Cloud Run, so locally the key is the constant 'dev-local'
// and nothing ever invalidates it — edited CSS/JS keeps serving from the worker's cache
// across restarts until you hard-refresh every page. Production is unaffected: each
// deploy is a new revision, so the key changes and `activate` drops the old caches.
//
// Set SW_ENABLE=true to exercise the PWA (offline page, precaching) locally.
app.locals.serviceWorkerEnabled =
  process.env.NODE_ENV === 'production' || process.env.SW_ENABLE === 'true';

// assetUrl('/static/css/style.css') -> '/static/css/style.css?v=<content hash>'
//
// tameside-badminton.co.uk is not served straight from Cloud Run: it resolves to
// Firebase Hosting, which proxies to this service and puts its CDN in front. That CDN
// caches /static/** for the `maxAge` advertised on the static mounts below — 30 days —
// and a Cloud Run deploy does not clear it. Firebase Hosting has no purge API at all
// (the only lever is publishing a whole new hosting release), so changing a file's
// contents without changing its URL leaves visitors on the stale copy until it expires.
//
// Hashing the contents rather than using K_REVISION means a deploy that doesn't touch
// a file leaves its URL alone, so it stays cached instead of being re-downloaded.
//
// Hashes are computed once in production, where the files are baked into the image by
// `npm run build:css`. Outside production they're recomputed per render, so editing a
// stylesheet is picked up without a restart.
const crypto = require('crypto');
const fs = require('fs');
const cacheAssetHashes = process.env.NODE_ENV === 'production';
const assetHashes = new Map();

app.locals.assetUrl = function assetUrl(urlPath) {
  let version = cacheAssetHashes ? assetHashes.get(urlPath) : undefined;

  if (!version) {
    try {
      const contents = fs.readFileSync(path.join(__dirname, urlPath));
      version = crypto.createHash('md5').update(contents).digest('hex').slice(0, 8);
    } catch (err) {
      // Don't let a missing asset break page rendering — fall back to the revision so
      // the URL still changes per deploy, and say so rather than failing silently.
      console.warn('assetUrl: could not hash', urlPath + ':', err.message);
      version = process.env.K_REVISION || 'dev-local';
    }
    if (cacheAssetHashes) { assetHashes.set(urlPath, version); }
  }

  return urlPath + '?v=' + version;
};

// Resolve the current/previous season from the DB (cached) at boot so every
// season-scoped query agrees on which season is "current", and cache the list
// of past seasons (those with an archived team<season> snapshot) for the
// History nav / archive page. Falls back to date-based derivation if the DB
// lookup fails (see models/season.js).
const seasonModel = require('./models/season');
const filterState = require('./middleware/filterState');

// Authorization: the player table is the source of truth, resolved at login by the
// Auth0Strategy verify callback below. utils/authz.js owns the claim key strings.
const Player = require('./models/players');
const authz = require('./utils/authz');

app.locals.pastSeasons = [];
seasonModel.init()
  .then(function (resolved) {
    console.log('Season resolved:', resolved.current, '(previous', resolved.previous + ')');
    return seasonModel.getAll();
  })
  .then(function (rows) {
    const current = seasonModel.current();
    app.locals.pastSeasons = rows.filter(function (s) { return s.name !== current; });
  })
  .then(function () {
    // Division/season option lists for the filter toolbar. Runs after
    // season.init() because the current season decides which seasons are
    // offerable (see middleware/filterState.js).
    //
    // Skipped under test for the same reason spamControls.refresh is below, but the
    // consequence here is worse than an extra connection. test/helpers/app.js sets
    // PGPASSWORD to a placeholder, and season.init() is stubbed there while this was
    // not — so every test file that required app.js opened a connection to the real
    // Supabase pooler and FAILED AUTHENTICATION. One run is ~15 failures. Enough runs
    // in quick succession and Supavisor trips its circuit breaker
    // (ECIRCUITBREAKER: "too many authentication failures, new connections are
    // temporarily blocked"), which blocks new connections for everything sharing that
    // pooler — including a cold-starting Cloud Run instance. Running the suite in a
    // loop is normal; taking the site's connection budget with it is not.
    if (process.env.NODE_ENV === 'test') return null;
    return filterState.init();
  })
  .then(function (counts) {
    if (counts) console.log('Filter options loaded:', counts.divisions, 'divisions,', counts.seasons, 'seasons');
  })
  .catch(function (err) {
    console.error('Season init/getAll failed:', err.message);
  });

// Warm the blocklist cache, because the sitewide IP check below reads it synchronously on
// every request and cannot await. A failure here leaves the lists empty rather than failing
// closed — the captcha, honeypot and timing floor all still apply — and the timer picks it
// up on the next tick.
const spamControls = require('./models/spamControls');

// Skipped under test: every test file that requires app.js would otherwise open its own DB
// connection here, on top of the one real-DB test in the suite. That extra connection per
// file was enough to make the suite intermittently fail against the Supabase pooler. The
// spam tests install lists through spamControls._setCacheForTests instead.
if (process.env.NODE_ENV !== 'test') {
  spamControls.refresh()
    .then(function () { console.log('Blocklists loaded'); })
    .catch(function (err) { console.error('blocklist load failed:', err.message); });

  // Keep the cache fresh so an admin change on /admin/spam lands within a minute on every
  // Cloud Run instance, with no restart and no cross-instance invalidation. unref() so this
  // timer never holds the process open.
  //
  // The interval comes from spamControls rather than being restated here, because it is
  // half of a pair: utils/db_connect.js's idle_timeout has to stay above it, or the
  // connection this timer uses is closed between ticks and every tick reconnects. That
  // was costing 1,800 connection opens/day before 2026-08-05.
  setInterval(function () {
    spamControls.refresh().catch(function (err) {
      console.error('blocklist refresh failed:', err.message);
    });
  }, spamControls.CACHE_TTL_MS).unref();
}

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');


// Compress text responses. Registered ahead of the static mounts and all routes so
// it covers both the served assets and the rendered HTML — nothing was compressed
// before this, so static/css/style.css went out as ~407KB of plain text on every
// uncached visit (it gzips to ~57KB). Cloud Run does not compress for you.
app.use(compression());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:false}));

// Must be registered before the `rootfiles` static mount below, or that
// mount shadows this route and the service worker never gets a fresh
// per-deploy cache version.
app.get('/sw.js', function(req, res) {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.render('sw', { cacheVersion: process.env.K_REVISION || 'dev-local' });
});

app.use(express.static('rootfiles'));
app.use('/static', express.static(path.join(__dirname,'/static'),{ maxAge: (30 * 24 * 60 * 60 * 1000) }));
app.use('/scripts', express.static(__dirname + '/node_modules',{ maxAge: (30 * 24 * 60 * 60 * 1000)} ));
app.use('/static/webfonts', express.static(__dirname + '/node_modules/@fortawesome/fontawesome-free/webfonts',{ maxAge: (30 * 24 * 60 * 60 * 1000)}));

// Fallback only. The `/static` mount above is registered first, so whenever
// static/css/style.css exists this middleware is never reached — which is the normal
// case, because `npm run build:css` generates it (in the Docker build, and via the
// `dev` script). It matters only if that file is missing, where it compiles on the
// first request rather than serving no CSS at all.
//
// Consequence worth knowing: editing bootstrap/style.scss has NO effect until you
// re-run `npm run build:css`, because the already-generated file keeps winning here.
app.use(sassMiddleware({
    src: path.join(__dirname, 'bootstrap'),
    dest: path.join(__dirname, 'static/css'),
    indentedSyntax: false, // true = .sass and false = .scss
     // debug:true,
     // force:true,
    prefix:'/static/css'
}))
// app.use('/public', express.static(path.join(__dirname, '/public')));

/* ------------------------------------------------------------------ *
 * Spam controls. Registered here deliberately — BELOW the static mounts above, so
 * neither of these runs for stylesheets, scripts or images. One page view would
 * otherwise mean a dozen HMACs and a dozen blocklist checks.
 * See migrations/spam-controls.sql and middleware/spamGate.js.
 * ------------------------------------------------------------------ */

// Blocked addresses come from the blocked_entry table via models/spamControls, so blocking
// someone is a form submission on /admin/spam rather than an edit to this file followed by
// a deploy. Read from the in-memory cache synchronously: this runs on every request, and
// awaiting a query here would put a DB round trip in front of every page.
const { clientIp: resolveClientIp } = require('./utils/clientIp');
app.use(function (req, res, next) {
  if (spamControls.isBlockedIpSync(resolveClientIp(req))) {
    return res.status(403).send('Forbidden');
  }
  next();
});

// Honeypot field name and a freshly signed render timestamp, for views/spam-fields.ejs.
// The stamp is per-request rather than app-wide because it has to be the time this page was
// rendered — that is the whole point of it. One HMAC per request is nothing.
const spamChecks = require('./utils/spamChecks');
app.locals.spamHoneypotField = spamChecks.HONEYPOT_FIELD;
app.use(function (req, res, next) {
  res.locals.spamFormStamp = spamChecks.formStamp();
  next();
});

var strategy = new Auth0Strategy(
    {
      domain: process.env.AUTH0_DOMAIN,
      clientID: process.env.AUTH0_CLIENTID,
      clientSecret: process.env.AUTH0_CLIENT_SECRET,
      callbackURL: process.env.AUTH0_CALLBACK_URL || 'http://127.0.0.1:8080/callback',
      state:true,
    },
    function (accessToken, refreshToken, extraParams, profile, done) {
      // accessToken is the token to call Auth0 API (not needed in the most cases)
      // extraParams.id_token has the JSON Web Token
      // profile has all the information from the user
      //
      // Authorization comes from the player table, not from Auth0 app_metadata
      // (migrations/player-auth-roles.sql). This writes the DB answer onto the same
      // three claim keys the rest of the app already reads, which is what kept that
      // switch to a handful of files: ~46 read sites, views/nav.ejs and
      // documentsController.hasClubAccess all carried on unchanged.
      //
      // One query per login, not per request — the whole profile is serialised into
      // the session for its lifetime. The flip side is that a role change only takes
      // effect on the person's next login.
      //
      // Note this is also what closes a cross-league leak: the Auth0 tenant is shared
      // with the Stockport league site (same domain, different application), so
      // app_metadata is one blob read by both. A Stockport club admin could arrive
      // here holding admin over a same-named Tameside club. Tameside's own player and
      // club tables can't say that.
      var email = (profile.emails && profile.emails[0] && profile.emails[0].value)
        || (profile._json && profile._json.email);

      Player.getAuthRoleByEmail(email).then(function (authRow) {
        authz.applyRoleClaims(profile._json, authRow);
        return done(null, profile);
      }).catch(function (err) {
        // Authentication now touches Postgres, which it never used to. Failing the
        // login here would mean a DB blip locks everyone out of a site that is
        // otherwise serving fine, so log it and continue with no role: the site stays
        // usable and the failure direction is toward less privilege, never more.
        // Same principle as models/spamControls never failing closed.
        console.error('[authz] role lookup failed at login:', err.message);
        Sentry.captureException(err);
        authz.applyRoleClaims(profile._json, null);
        return done(null, profile);
      });
    }
  );

  passport.use(strategy);
  // You can use this section to keep a smaller payload
  passport.serializeUser(function (user, done) {
    done(null, user);
  });

  passport.deserializeUser(function (user, done) {
    done(null, user);
  });

  // config express-session
  var sess = {
    name:'__session',
    secret: process.env.SESSION_SECRET || 'ThisisMySecret',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
    },
    resave: false,
    saveUninitialized: false
  };
  if (app.get('env') === 'production') {
    app.set('trust proxy', 1);
    sess.proxy = true;
    sess.cookie.secure = true;
  }
  app.use(session(sess));
  app.use(passport.initialize());
  app.use(passport.session());

  // Local-only superadmin injection (no-op unless DEV_MODE=true && not production).
  // Must come after passport.session() so it isn't overwritten.
  app.use(require('./middleware/devMode'));

let static_controller = require(__dirname + '/controllers/staticPagesController');
let team_controller = require(__dirname + '/controllers/teamController');
let fixture_controller = require(__dirname + '/controllers/fixtureController');
let league_controller = require(__dirname + '/controllers/leagueController');
let club_controller = require(__dirname + '/controllers/club_controller');
let contactus_controller = require(__dirname + '/controllers/contactusController');
let spam_admin_controller = require(__dirname + '/controllers/spamAdminController');
let auth_link_controller = require(__dirname + '/controllers/authLinkController');
const spamGate = require(__dirname + '/middleware/spamGate');
let player_controller = require(__dirname + '/controllers/playerController');
let userInViews = require(__dirname + '/models/userInViews');
var auth_controller = require(__dirname + '/models/auth.js');
let social_controller = require(__dirname + '/controllers/social_controller')
let fixture_gen_controller = require(__dirname + '/controllers/fixtureGenController')
let homepage_content_controller = require(__dirname + '/controllers/homepageContentController')
let site_settings_controller = require(__dirname + '/controllers/siteSettingsController')
let documents_controller = require(__dirname + '/controllers/documentsController')
let team_registration_controller = require(__dirname + '/controllers/teamRegistrationController')

app.use(userInViews())

// Parses the filter path segments (/player-stats/Division-1/gender-Male/...) into
// res.locals.filterBar, so views/filters.ejs can show what's applied and build
// links that add or drop one filter without losing the others.
app.use(filterState.middleware)

    

    // `secured`, and no longer `ACL: 'public-read'`.
    //
    // This was an UNAUTHENTICATED endpoint that presigned a PUT with a caller-chosen key
    // and content type into a bucket shared with the Stockport league site — so anyone
    // could write any object anywhere in it, including over another league's scorecards,
    // and every object it minted was world-readable by its own ACL. Every caller is on a
    // `secured` page already (the entry wizard and the OCR panel, both in
    // views/email-scorecard.ejs), so the session requirement costs nothing; the service
    // worker never touches this path (EXCLUDED_PATH_PREFIXES in views/sw.ejs).
    //
    // Dropping the ACL is what makes the private read path durable. Stockport's sweep
    // over the bucket root is one-off; while this line stayed, the bucket would drift
    // back to world-readable one scorecard at a time and nobody would notice.
    // Objects already in the bucket keep the ACL they were written with — that half is
    // the sweep's job, on their side, and nothing here depends on which way it has gone:
    // GET /scorecard-photo/:id reads with credentials either way.
    app.get('/sign-s3', secured, async (req, res, next) => {
      const fileName = req.query['file-name'];
      const fileType = req.query['file-type'];
      const s3Params = {
          Bucket: process.env.S3_BUCKET_NAME,
          Key: fileName,
          ContentType: fileType,
      };
      // Prefer the S3_LOGS_STORAGE key pair: the default AWS_ACCESS_KEY_ID env
      // credential was rotated out at some point, so URLs presigned with it get
      // 403 InvalidAccessKeyId from S3 — which silently broke ALL scorecard
      // photo uploads until the OCR wizard surfaced it. utils/s3.js owns that choice
      // now, because three copies of it is how one gets missed at the next rotation.
      const s3 = s3Client()
      const command = new PutObjectCommand(s3Params);
  
      try {
          const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });
          console.log(signedUrl);
          res.json({ signedUrl })
      } catch (err) {
          console.error(err);
          next(err);
      }
  });

  app.post('/new-users-v2',contactus_controller.new_user)

  // Approving a signup grants login access and can grant a site role, so both halves
  // are `secured` plus a superadmin check in the handler. The GET was previously open
  // to anyone who knew an Auth0 user_id — and, being a GET with side effects, to any
  // scanner that prefetched the link in the notification email. The GET now only
  // renders; the POST does the work.
  app.get('/approve-user/:userId', secured, auth_controller.approve_signup_get);
  app.post('/approve-user/:userId', secured, auth_controller.approve_signup_post);


app.get('/resultImage/:homeTeam/:awayTeam/:homeScore/:awayScore/:division',social_controller.social_get_result)
app.get('/tables-social',social_controller.social_get_tables)

app.get('/', fixture_controller.fixture_get_summary)
app.get('/contact-us', contactus_controller.contactus_get)
// spamGate runs the honeypot and timing-floor checks before validation, and answers a
// bland success to anything it rejects (see middleware/spamGate.js for why). Any new
// public form needs this on its POST route *and* views/spam-fields.ejs inside its <form>.
app.post('/contact-us', spamGate({ endpoint: '/contact-us' }), contactus_controller.validateContactUs, contactus_controller.contactus);
app.get('/info/clubs', club_controller.club_list_detail)
app.get('/rules', static_controller.rules)
app.get('/history', static_controller.history)
app.get('/mailjet', contactus_controller.mailjet_test)
app.get('/event/:id/:date-:homeTeam-:awayTeam', fixture_controller.fixture_event_detail);

/* POST request for batch creating Fixture. */
app.post('/fixture/rearrangement', secured, fixture_controller.fixture_rearrange_by_team_name);

// Filters are path segments in the shared grammar (season positional, everything
// else `key-value`) that views/filtersJs.ejs and middleware/filterState.js both
// emit. Take the whole tail and let the middleware parse it, the way every other
// filtered page works — /player-stats/*, /pair-stats/*, /results/*.
//
// This used to be six hand-written shapes in an older grammar that put the season
// *after* the club (`/fixture-players/club-Hyde/20252026`). The shared builder
// emits season first, so applying any two filters at once produced
// `/fixture-players/20252026/club-Hyde` and 404'd. Those legacy URLs still work:
// filterState's parser reads `club-`, `team-`, `season-` and a bare 8-digit season
// in any order.
app.get('/fixture-players', fixture_controller.get_fixture_players_details);
app.get('/fixture-players/*', fixture_controller.get_fixture_players_details);
app.post('/fixture/reminder', fixture_controller.fixture_reminder_post);


app.get('/fixtures/*', fixture_controller.fixture_detail_byDivision);
app.get('/results/*', fixture_controller.fixture_detail_byDivision);
app.get('/calendars/*', fixture_controller.fixture_calendars);
app.get('/results-grid/*', fixture_controller.fixture_detail_byDivision);

/* GET request for list of all League items. */
app.get('/tables/All', league_controller.all_league_tables);
app.get('/tables/All/:season', league_controller.all_league_tables);

/* GET request for list of all League items. */
app.get('/tables/:division', league_controller.league_table);
app.get('/tables/:division/:season', league_controller.league_table);

app.get('/team/:id(\\d+)', team_controller.team_detail);

/* GET request for list of all Team items.
    router.get('/teams/:clubid/:venue/:matchDay', team_controller.team_list); */

/* GET request for list of all Team items. */
app.get('/teams', team_controller.team_list);
app.get('/clubs', club_controller.club_list);

/* GET request for list of all Team items. */
app.post('/teams', team_controller.team_search);

/* GET request to delete Club. */
app.get('/club/:id(\\d+)/delete', club_controller.club_delete_get);

// DELETE request to delete Club
app.delete('/club/:id(\\d+)',checkJwt, club_controller.club_delete_post);

/* GET request to update Club. */
app.get('/club/:id(\\d+)/update', club_controller.club_update_get);

// PATCH request to update Club
app.patch('/club/:id(\\d+)',checkJwt, club_controller.club_update_post);

/* GET request for one Player. */
app.get('/eligiblePlayers/:id(\\d+)/:gender', player_controller.eligible_players_list);

/* GET request for list of all Player items. */
app.get('/players/club-:clubid?/team-:teamid?/gender-:gender?', player_controller.player_list);
app.get('/players/matching/:name/:gender',player_controller.find_closest_matched_player);
app.post('/player/create', secured, player_controller.player_create);

/* ELO ratings: chart page (login required), public JSON APIs, admin backfill
   (secured + superadmin check in controller), DEV_MODE-only diagnostics. */
app.get('/elo-chart', secured, player_controller.player_elo_chart);
app.get('/api/player-elo', player_controller.player_elo_history_api);
app.get('/api/players/search', player_controller.player_search_api);
app.get('/api/seasons', player_controller.get_seasons_api);
app.get('/players/eloBackfillAdmin', secured, player_controller.player_elo_backfill_admin);
app.get('/players/eloBackfillAll', secured, player_controller.player_elo_backfill_all);
app.get('/players/eloFullRecalc', secured, player_controller.player_elo_full_recalc);
app.get('/dev/elo-audit', player_controller.player_elo_audit);
app.get('/dev/elo-raw/:playerId(\\d+)', player_controller.player_elo_raw);

/* GET request to update Player. */
// `secured` because this form shows decrypted contact details (email and phone) and
// now the site-role controls too. It had no auth gate of any kind: the page was
// readable by anyone who guessed a player id.
app.get('/player/:id(\\d+)/update', secured, player_controller.player_update_get);

app.get('/player/:id(\\d+)', player_controller.player_detail);

/* GET request for one Player. */
app.get('/playerStats/:id(\\d+)/:fullName', player_controller.player_game_data);

/* player stats routes and filters. */



/* GET request for one Player. */
// app.get('/player-stats', player_controller.all_player_stats);
app.get('/lewis-shield', team_controller.lewis_draw);
app.get('/lewis-shield/:season', team_controller.lewis_draw);



app.post('/manage-players/create', secured, player_controller.player_create_from_team);
app.get('/populated-scorecard/:division/:home_team/:away_team/:home_man_1/:home_man_2/:home_man_3/:home_man_4/:home_lady_1/:home_lady_2/:away_man_1/:away_man_2/:away_man_3/:away_man_4/:away_lady_1/:away_lady_2/:Game1homeScore/:Game1awayScore/:Game2homeScore/:Game2awayScore/:Game3homeScore/:Game3awayScore/:Game4homeScore/:Game4awayScore/:Game5homeScore/:Game5awayScore/:Game6homeScore/:Game6awayScore/:Game7homeScore/:Game7awayScore/:Game8homeScore/:Game8awayScore/:Game9homeScore/:Game9awayScore/:Game10homeScore/:Game10awayScore/:Game11homeScore/:Game11awayScore/:Game12homeScore/:Game12awayScore/:Game13homeScore/:Game13awayScore/:Game14homeScore/:Game14awayScore/:Game15homeScore/:Game15awayScore/:Game16homeScore/:Game16awayScore/:Game17homeScore/:Game17awayScore/:Game18homeScore/:Game18awayScore', secured, (req,res,next) => {
  console.log(req.params)
  fixture_controller.fixture_populate_scorecard_fromUrl(req,res,next)
})

app.get('/scorecard/fixture/:id(\\d+)', fixture_controller.getScorecard);




/* Homepage content management (announcements + site settings) — secured,
   with a superadmin check inside each controller handler. */
app.get('/admin/homepage-content', secured, homepage_content_controller.list);
app.get('/admin/homepage-content/create', secured, homepage_content_controller.createForm);
app.post('/admin/homepage-content', secured, homepage_content_controller.create);
app.get('/admin/homepage-content/:id', secured, homepage_content_controller.editForm);
app.post('/admin/homepage-content/:id', secured, homepage_content_controller.update);
app.post('/admin/homepage-content/:id/delete', secured, homepage_content_controller.remove);
app.get('/admin/site-settings', secured, site_settings_controller.form);
app.post('/admin/site-settings', secured, site_settings_controller.update);

// Blocklists and the submission log. `secured` proves someone is logged in; the controller
// checks superadmin, same as the other /admin screens.
// One-time worklist for the Auth0 -> player-table authorization migration. Superadmin
// check is in the controller, as with every other /admin page.
app.get('/admin/link-auth-accounts', secured, auth_link_controller.list);
app.post('/admin/link-auth-accounts', secured, auth_link_controller.link);

app.get('/admin/spam', secured, spam_admin_controller.form);
app.post('/admin/spam', secured, spam_admin_controller.add);
app.post('/admin/spam/:id/active', secured, spam_admin_controller.toggle);

/* League structure admin (superadmin only — secured route + role check in the
   controller). Clubs, teams, and one-click promotion/relegation. */
app.get('/admin/clubs', secured, club_controller.admin_club_list);
app.get('/admin/clubs/create', secured, club_controller.admin_club_createForm);
app.post('/admin/clubs', secured, club_controller.admin_club_create);
app.get('/admin/clubs/:id(\\d+)', secured, club_controller.admin_club_editForm);
app.post('/admin/clubs/:id(\\d+)', secured, club_controller.admin_club_update);
app.get('/admin/teams', secured, team_controller.admin_team_list);
app.get('/admin/teams/create', secured, team_controller.admin_team_createForm);
app.post('/admin/teams', secured, team_controller.admin_team_create);
app.post('/admin/teams/:id(\\d+)/move', secured, team_controller.admin_team_move);
app.get('/admin/teams/:id(\\d+)', secured, team_controller.admin_team_editForm);
app.post('/admin/teams/:id(\\d+)', secured, team_controller.admin_team_update);
app.post('/admin/fixture/:id(\\d+)/date', secured, fixture_controller.admin_fixture_date_update);
app.get('/admin/lewis', secured, team_controller.admin_lewis_form);
app.post('/admin/lewis/:drawPos(\\d+)/result', secured, team_controller.admin_lewis_result);

/* Scorecard OCR (superadmin): read an uploaded scorecard photo with Google
   Vision, match players against the rosters, review, then hand off into the
   existing prefilled-scorecard entry flow. */
let scorecard_ocr_controller = require(__dirname + '/controllers/scorecardOcrController');
app.get('/admin/scorecard-ocr', secured, scorecard_ocr_controller.list);
app.get('/admin/scorecard-ocr/review', secured, scorecard_ocr_controller.review);
app.get('/admin/scorecard-ocr/image', secured, scorecard_ocr_controller.image);
/* Entry-wizard integration: any logged-in user uploads a photo (sign-s3), then
   posts the key here to get the prefilled-form URL. */
app.post('/scorecard-ocr/analyse', secured, scorecard_ocr_controller.analyse);

/* Distribution lists (superadmin — role check in controller). */
app.get('/admin/distribution', secured, contactus_controller.admin_distribution_form);
app.post('/admin/distribution/preview', secured, contactus_controller.admin_distribution_preview);
app.post('/admin/distribution/send', secured, contactus_controller.admin_distribution_send);

app.post('/scorecard-beta', secured, fixture_controller.validateScorecard, fixture_controller.full_fixture_post);

app.get('/populated-scorecard-beta/:id(\\d+)', secured, (req,res,next) => {
  console.log(req.body);
  fixture_controller.fixture_populate_scorecard_fromId(req,res,next)
})

function secured(req, res, next) {
    if (req.isAuthenticated()) {
      return next();
    }
    req.session.returnTo = req.originalUrl;
    res.redirect('/login');
  }

  app.get('/login', function(req, res, next) {
    passport.authenticate('auth0', {
      scope: 'openid email profile'
    })(req, res, next);
  });

  app.get('/callback', function(req, res, next) {
    passport.authenticate('auth0', function(err, user, info) {
      console.log(err);
      console.log(user);
      console.log(info);
      if (err) { return next(err); }
      if (!user) {
        console.log("not user")
        /* res.render('failed-login', {
          static_path:'/static',
          theme:process.env.THEME || 'flatly',
          title : "Access Denied",
          pageDescription : "Access Denied",
          query:req.query
        }); */
        return res.redirect('/login')
      } else {
        const returnTo = req.session.returnTo;
        delete req.session.returnTo;
        req.logIn(user, function (err) {
          if (err) { return next(err); }
          // Only redirect to same-site paths (captured before logIn regenerates the session)
          const safePath = (returnTo && returnTo.startsWith('/')) ? returnTo : '/';
          res.redirect(safePath);
        });
      }
    })(req, res, next);
  });

  app.get('/logout', function(req, res, next) {
    req.logout(function(err) {
      if (err) { return next(err); }
      res.redirect('https://'+ process.env.AUTH0_DOMAIN + '/v2/logout?clientid='+ process.env.AUTH0_CLIENTID +'&returnTo=https://'+ req.headers.host);
    });
  });

  app.get('/player-stats/*',  secured, player_controller.all_player_stats);
  app.get('/player-stats',  secured, player_controller.all_player_stats);

  app.get('/pair-stats/*',  secured, player_controller.all_pair_stats);
  app.get('/pair-stats',  secured, player_controller.all_pair_stats);

  app.get('/admin/results/*', secured,fixture_controller.fixture_detail_byDivision);
  app.get('/admin/results/:division/:season',  secured,fixture_controller.fixture_detail_byDivision);
  // Fixture generator (secured — admin only)
  app.get('/fixture-gen', secured, fixture_gen_controller.renderFixtures);
  app.post('/fixture-gen/regenerate', secured, fixture_gen_controller.regenerateFixtures);
  app.post('/fixture-gen/publish', secured, fixture_gen_controller.publishFixtures);

  app.get('/club/:id', secured,club_controller.club_detail);
  
  app.get('/players/club-:club?/team-:team?/gender-:gender?', secured,player_controller.player_list_clubs_teams);
  app.get('/players/club-:club?', secured,player_controller.player_list_clubs_teams);
  app.get('/players/team-:team?', secured,player_controller.player_list_clubs_teams);
  app.get('/players/gender-:gender?', secured,player_controller.player_list_clubs_teams);
  app.get('/players', secured,player_controller.player_list_clubs_teams);
  app.get('/played-up-counts', secured,player_controller.player_played_up_counts);
  app.get('/manage-players/club-:club?', secured,player_controller.manage_player_list_clubs_teams);
  app.get('/manage-players/:season?/club-:club?', secured,player_controller.manage_player_list_clubs_teams);
  // Team registration form, prefilled with a club's current registrations
  // (auth check in controller). Blank template is served statically from
  // /static/docs/Team Registration.pdf.
  app.get('/forms/team-registration/:club/prefilled', secured, documents_controller.teamRegistrationFormPrefilled);
  app.get('/email-scorecard', secured,fixture_controller.email_scorecard);
  app.post('/email-scorecard', secured, fixture_controller.validateScorecard, fixture_controller.fixture_populate_scorecard_errors);
  app.post('/add-scorecard-photo/:id(\\d+)', secured, fixture_controller.add_scorecard_photo)
  // Registration-form import: upload the .docx or PDF a club sent back, see it diffed
  // against the current roster, tick what to apply. Superadmin or a club admin for their
  // own club — checked in the controller, and the write path enforces club scope again
  // independently.
  //
  // The review route takes the file as the RAW request body rather than as multipart:
  // this app has no multipart parser and does not need one for a single file. The limit is
  // sized for the PDF, whose template alone is ~1MB before a club fills it in — the .docx
  // is about 8KB. express.raw is mounted on this one route, not globally, so nothing else
  // starts buffering bodies.
  app.get('/admin/team-registrations', secured, team_registration_controller.index);
  app.post('/admin/team-registrations/review', secured,
    express.raw({ type: () => true, limit: '12mb' }),
    team_registration_controller.review);
  app.post('/admin/team-registrations/apply', secured, team_registration_controller.apply);

  // The only way a scorecard photo is read. Keyed by scorecardstore id, never by object
  // key — see controllers/fixtureController.js and utils/scorecardPhoto.js for why that
  // matters when the bucket is shared with the other league. `(\\d+)` so a non-numeric id
  // is a routing 404 rather than a Postgres type error rendered as a 500.
  app.get('/scorecard-photo/:id(\\d+)', secured, fixture_controller.scorecard_photo)


  /* GET request for creating a Player. NOTE This must come before routes that display Player (uses id) */
  app.get('/player/create', secured,player_controller.player_create_get);
  // Was ungated entirely, and took `tablename`/`fields`/`data` from the request body —
  // an unauthenticated write to any table, column and row in the database, `player.role`
  // included. Kept (not removed) because the team-admin drag-and-drop and the
  // add-player modal all drive it; narrowed to that use in the controller.
  app.post('/player/batch-update', secured, player_controller.player_batch_update);
  app.post('/player/:id',secured, player_controller.player_update_post);
  app.get('/club-api/:id', secured,club_controller.club_detail_api);
  app.get('/admin/info/clubs', secured,club_controller.club_list_detail);

app.use(function(req, res) {
  // Never let the CDN cache error pages: the domain fronts Cloud Run through
  // Firebase Hosting, whose edge applies a default 10-minute cache to any
  // cookie-less response with no Cache-Control header. Without this, a 404
  // served moments before a deploy lands keeps 404ing a brand-new route for
  // 10 minutes after it goes live (this actually happened).
  res.set('Cache-Control', 'private, no-store');
  res.status(404);
  res.render('404-error', {
      pageHeading: "404",
      title: "404",
      static_path: "/static",
      title : "Can't find the page your looking for",
      pageDescription : "Can't find the page your looking for",
      entry : "<p>Sorry can't find that page</p>"
 });
})

// Central 500 handler. MUST take 4 args (err, req, res, next) — Express only
// recognises error-handling middleware by arity, so a 3-arg version never fires.
// Report to Sentry before rendering: flush first so the event is sent while Cloud
// Run still has CPU allocated (post-response CPU is throttled), capped so the
// error page isn't held up if Sentry is slow/unreachable.
app.use(function(error, req, res, next) {
    // A 4xx carried on an Error is an *expected* condition someone chose to signal —
    // "you may not edit this player", "no such Auth0 account", "pick a player first".
    // Without this branch all three answered 500 and spent a Sentry event each, which
    // buries the real faults. Only 5xx is a fault.
    const status = Number(error && error.status) || 500;
    res.set('Cache-Control', 'private, no-store'); // never edge-cache error pages

    if (status >= 400 && status < 500) {
      res.status(status);
      if (status === 404) {
        return res.render('404-error', {
          static_path: "/static",
          title: "Can't find the page your looking for",
          pageDescription: "Can't find the page your looking for",
          entry: "<p>Sorry can't find that page</p>"
        });
      }
      // 403/400 and friends. Reuses the 500 template purely as a generic message page
      // — it takes a heading and a body and has no 500-specific content.
      return res.render('500-error', {
        pageHeading: String(status),
        static_path: "/static",
        title: status === 403 ? "You don't have access to that" : "That request couldn't be processed",
        pageDescription: status === 403 ? "You don't have access to that" : "That request couldn't be processed",
        entry: "<p>" + (error.message || 'Sorry, that request could not be processed') + "</p>"
      });
    }

    console.error(error);
    Sentry.captureException(error);
    Sentry.flush(2000).catch(() => {}).finally(function() {
        res.status(500);
        res.render('500-error', {
            pageHeading: "500",
            static_path: "/static",
            title : "Sorry - theres been an error",
            pageDescription : "Sorry - theres been an error",
            entry : "<p>Sorry there's been an error</p>"
       });
    });
  })

module.exports = app