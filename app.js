// gcloud builds submit --region=global --config cloudbuild.yaml
// gcloud run deploy tameside-site --image europe-west2-docker.pkg.dev/avid-compound-429108-g9/cloud-run-source-deploy/tameide-image:tag1

// Sentry instrumentation — must load before express and other modules so Sentry
// can auto-instrument them. No-op unless SENTRY_DSN is set (see instrument.js).
require('./instrument');
const Sentry = require('@sentry/node');

require('dotenv').config()
const express = require('express')
const session = require('express-session');
const passport = require('passport');
const Auth0Strategy = require('passport-auth0');
const bodyParser = require('body-parser');
const {check, validationResult} = require('express-validator')
let { expressjwt: jwt } = require("express-jwt");
let jwksRsa = require('jwks-rsa');
let sassMiddleware = require('express-dart-sass')
let path = require('path')
const {
  S3Client,
  PutObjectCommand,
} = require ("@aws-sdk/client-s3");
const { getSignedUrl } = require ("@aws-sdk/s3-request-presigner");
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

// Resolve the current/previous season from the DB (cached) at boot so every
// season-scoped query agrees on which season is "current", and cache the list
// of past seasons (those with an archived team<season> snapshot) for the
// History nav / archive page. Falls back to date-based derivation if the DB
// lookup fails (see models/season.js).
const seasonModel = require('./models/season');
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
  .catch(function (err) {
    console.error('Season init/getAll failed:', err.message);
  });

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');


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

app.use(sassMiddleware({
    src: path.join(__dirname, 'bootstrap'),
    dest: path.join(__dirname, 'static/css'),
    indentedSyntax: false, // true = .sass and false = .scss
     // debug:true,
     // force:true,
    prefix:'/static/css'
}))
// app.use('/public', express.static(path.join(__dirname, '/public')));

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
      return done(null, profile);
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
let player_controller = require(__dirname + '/controllers/playerController');
let userInViews = require(__dirname + '/models/userInViews');
var auth_controller = require(__dirname + '/models/auth.js');
let social_controller = require(__dirname + '/controllers/social_controller')
let fixture_gen_controller = require(__dirname + '/controllers/fixtureGenController')
let homepage_content_controller = require(__dirname + '/controllers/homepageContentController')
let site_settings_controller = require(__dirname + '/controllers/siteSettingsController')

app.use(userInViews())

    

    app.get('/sign-s3', async (req, res, next) => {
      const fileName = req.query['file-name'];
      const fileType = req.query['file-type'];
      const s3Params = {
          Bucket: process.env.S3_BUCKET_NAME,
          Key: fileName,
          ContentType: fileType,
          ACL: 'public-read'
          // ACL: 'bucket-owner-full-control'
      };
      const s3 = new S3Client({ region: 'eu-west-1' })
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
  app.get('/approve-user/:userId',auth_controller.grantResultsAccess);


app.get('/resultImage/:homeTeam/:awayTeam/:homeScore/:awayScore/:division',social_controller.social_get_result)
app.get('/tables-social',social_controller.social_get_tables)

app.get('/', fixture_controller.fixture_get_summary)
app.get('/contact-us', contactus_controller.contactus_get)
app.post('/contact-us',contactus_controller.validateContactUs, contactus_controller.contactus);
app.get('/info/clubs', club_controller.club_list_detail)
app.get('/rules', static_controller.rules)
app.get('/history', static_controller.history)
app.get('/mailjet', contactus_controller.mailjet_test)
app.get('/event/:id/:date-:homeTeam-:awayTeam', fixture_controller.fixture_event_detail);

/* POST request for batch creating Fixture. */
app.post('/fixture/rearrangement', secured, fixture_controller.fixture_rearrange_by_team_name);

app.get('/fixture-players', fixture_controller.get_fixture_players_details);
app.get('/fixture-players/team-:team?', fixture_controller.get_fixture_players_details);
app.get('/fixture-players/club-:club?', fixture_controller.get_fixture_players_details);
app.get('/fixture-players/:season?', fixture_controller.get_fixture_players_details);
app.get('/fixture-players/team-:team?/season-:season?', fixture_controller.get_fixture_players_details);
app.get('/fixture-players/club-:club?/:season?', fixture_controller.get_fixture_players_details);
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
app.get('/player/:id(\\d+)/update', player_controller.player_update_get);

app.get('/player/:id(\\d+)', player_controller.player_detail);

/* GET request for one Player. */
app.get('/playerStats/:id(\\d+)/:fullName', player_controller.player_game_data);

/* player stats routes and filters. */



/* GET request for one Player. */
// app.get('/player-stats', player_controller.all_player_stats);
app.get('/lewis-shield', team_controller.lewis_draw);
app.get('/lewis-shield/:season', team_controller.lewis_draw);



app.post('/manage-players/create', secured, player_controller.player_create_from_team);
app.get('/populated-scorecard/:division/:home_team/:away_team/:home_man_1/:home_man_2/:home_man_3/:home_man_4/:home_lady_1/:home_lady_2/:away_man_1/:away_man_2/:away_man_3/:away_man_4/:away_lady_1/:away_lady_2/:Game1homeScore/:Game1awayScore/:Game2homeScore/:Game2awayScore/:Game3homeScore/:Game3awayScore/:Game4homeScore/:Game4awayScore/:Game5homeScore/:Game5awayScore/:Game6homeScore/:Game6awayScore/:Game7homeScore/:Game7awayScore/:Game8homeScore/:Game8awayScore/:Game9homeScore/:Game9awayScore/:Game10homeScore/:Game10awayScore/:Game11homeScore/:Game11awayScore/:Game12homeScore/:Game12awayScore/:Game13homeScore/:Game13awayScore/:Game14homeScore/:Game14awayScore/:Game15homeScore/:Game15awayScore/:Game16homeScore/:Game16awayScore/:Game17homeScore/:Game17awayScore/:Game18homeScore/:Game18awayScore', (req,res,next) => {
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

/* Distribution lists (superadmin — role check in controller). */
app.get('/admin/distribution', secured, contactus_controller.admin_distribution_form);
app.post('/admin/distribution/preview', secured, contactus_controller.admin_distribution_preview);
app.post('/admin/distribution/send', secured, contactus_controller.admin_distribution_send);

app.post('/scorecard-beta', secured, fixture_controller.validateScorecard, fixture_controller.full_fixture_post);

app.get('/populated-scorecard-beta/:id',(req,res,next) => {
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
  app.get('/email-scorecard', secured,fixture_controller.email_scorecard);
  app.post('/email-scorecard', fixture_controller.validateScorecard, fixture_controller.fixture_populate_scorecard_errors);
  app.post('/add-scorecard-photo/:id',fixture_controller.add_scorecard_photo)
  

  /* GET request for creating a Player. NOTE This must come before routes that display Player (uses id) */
  app.get('/player/create', secured,player_controller.player_create_get);
  app.post('/player/batch-update',player_controller.player_batch_update);
  app.post('/player/:id',secured, player_controller.player_update_post);
  app.get('/club-api/:id', secured,club_controller.club_detail_api);
  app.get('/admin/info/clubs', secured,club_controller.club_list_detail);

app.use(function(req, res) {
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