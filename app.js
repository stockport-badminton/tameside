// gcloud builds submit --region=global --config cloudbuild.yaml
// gcloud run deploy tameside-site --image europe-west2-docker.pkg.dev/avid-compound-429108-g9/cloud-run-source-deploy/tameide-image:tag1

require('dotenv').config()
const express = require('express')
const session = require('express-session');
const passport = require('passport');
const Auth0Strategy = require('passport-auth0');
const bodyParser = require('body-parser');
const {check, validationResult} = require('express-validator')
let { expressjwt: jwt } = require("express-jwt");
let jwksRsa = require('jwks-rsa');
let sassMiddleware = require('node-sass-middleware')
let path = require('path')
let postgres = require('postgres')
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false } })
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

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:false}));
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
    secret: 'ThisisMySecret',
    cookie: {secure:false},
    resave: false,
    saveUninitialized: false
  };
  if (app.get('env') === 'prod') {
// console.log("prod environment")
    app.set('trust proxy', 1); // trust first proxy
    sess.cookie.secure = true; // serve secure cookies, requires https
    sess.proxy = true;
    // console.log("session:sess");
    // console.log(sess);
  }  
  app.use(session(sess));
  app.use(passport.initialize());
  app.use(passport.session());

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

let currentURL = ''
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
app.get('/how-to-find-us', static_controller.howToFindUs)
app.get('/links', static_controller.linksPage)
app.get('/gallery', static_controller.galleryPage)
app.get('/news', static_controller.newsPage)
app.get('/contact-us', contactus_controller.contactus_get)
app.post('/contact-us',contactus_controller.validateContactUs, contactus_controller.contactus);
app.get('/info/clubs', club_controller.club_list_detail)
app.get('/rules', static_controller.rules)
app.get('/mailjet', contactus_controller.mailjet_test)
app.get('/event/:id/:date-:homeTeam-:awayTeam', fixture_controller.fixture_event_detail);

/* POST request for batch creating Fixture. */
app.post('/fixture/rearrangement', fixture_controller.fixture_rearrange_by_team_name);

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

app.get('/team/:id', team_controller.team_detail);

/* GET request for list of all Team items.
    router.get('/teams/:clubid/:venue/:matchDay', team_controller.team_list); */

/* GET request for list of all Team items. */
app.get('/teams', team_controller.team_list);
app.get('/clubs', club_controller.club_list);

/* GET request for list of all Team items. */
app.post('/teams', team_controller.team_search);

/* GET request to delete Club. */
app.get('/club/:id/delete', club_controller.club_delete_get);

// DELETE request to delete Club
app.delete('/club/:id',checkJwt, club_controller.club_delete_post);

/* GET request to update Club. */
app.get('/club/:id/update', club_controller.club_update_get);

// PATCH request to update Club
app.patch('/club/:id',checkJwt, club_controller.club_update_post);

/* GET request for one Player. */
app.get('/eligiblePlayers/:id/:gender', player_controller.eligible_players_list);

/* GET request for list of all Player items. */
app.get('/players/club-:clubid?/team-:teamid?/gender-:gender?', player_controller.player_list);
app.get('/players/matching/:name/:gender',player_controller.find_closest_matched_player);
app.post('/player/create', player_controller.player_create);

app.get('/players/eloPop', player_controller.player_elo_populate);

/* GET request to update Player. */
app.get('/player/:id/update', player_controller.player_update_get);

app.get('/player/:id', player_controller.player_detail);

/* GET request for one Player. */
app.get('/playerStats/:id/:fullName', player_controller.player_game_data);

/* player stats routes and filters. */

app.get('/player-stats/*', player_controller.all_player_stats);
app.get('/player-stats', player_controller.all_player_stats);

app.get('/pair-stats/*', player_controller.all_pair_stats);
app.get('/pair-stats', player_controller.all_pair_stats);

/* GET request for one Player. */
app.get('/player-stats', player_controller.all_player_stats);
app.get('/lewis-shield', team_controller.lewis_draw);
app.get('/lewis-shield/:season', team_controller.lewis_draw);



app.post('/manage-players/create', player_controller.player_create_from_team);
app.get('/populated-scorecard/:division/:home_team/:away_team/:home_man_1/:home_man_2/:home_man_3/:home_man_4/:home_lady_1/:home_lady_2/:away_man_1/:away_man_2/:away_man_3/:away_man_4/:away_lady_1/:away_lady_2/:Game1homeScore/:Game1awayScore/:Game2homeScore/:Game2awayScore/:Game3homeScore/:Game3awayScore/:Game4homeScore/:Game4awayScore/:Game5homeScore/:Game5awayScore/:Game6homeScore/:Game6awayScore/:Game7homeScore/:Game7awayScore/:Game8homeScore/:Game8awayScore/:Game9homeScore/:Game9awayScore/:Game10homeScore/:Game10awayScore/:Game11homeScore/:Game11awayScore/:Game12homeScore/:Game12awayScore/:Game13homeScore/:Game13awayScore/:Game14homeScore/:Game14awayScore/:Game15homeScore/:Game15awayScore/:Game16homeScore/:Game16awayScore/:Game17homeScore/:Game17awayScore/:Game18homeScore/:Game18awayScore', (req,res,next) => {
  console.log(req.params)
  fixture_controller.fixture_populate_scorecard_fromUrl(req,res,next)
})

app.get('/scorecard/fixture/:id', fixture_controller.getScorecard);




//POST for processing results entry form - possibly redundant.
app.post('/scorecard-beta',fixture_controller.validateScorecard, fixture_controller.full_fixture_post);

app.get('/populated-scorecard-beta/:id',(req,res,next) => {
  console.log(req.body);
  fixture_controller.fixture_populate_scorecard_fromId(req,res,next)
})

function secured(req, res, next) {
    if (req.isAuthenticated()) {
      console.log(`user: ${req.user.displayName}`)
      console.log(`page: ${req.url}`)
      return next();
    }
    // console.log('Original URL:', req.originalUrl);
    currentURL = req.originalUrl
    // const returnTo = req.query.state || req.originalUrl;
    req.session.returnTo = req.originalUrl; 
    res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
  }

  app.get('/login', function(req, res, next) {
    const returnTo = req.query.returnTo;
    if (returnTo){
      req.session.returnTo = returnTo
    }
    passport.authenticate('auth0', {
      scope: 'openid email profile',
      nonce: Math.random().toString(36).substr(2)
    })(req, res, next);
  });

  app.get('/callback', function(req, res, next) {
    passport.authenticate('auth0', function(err, user, info) {
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
        req.logIn(user, function (err) {
          if (err) {console.log(err); return next(err); }
          // console.log("callback session returnTo:" + req.session.returnTo)
          // console.log("callback currentUrl:" + currentURL)
          const returnTo = currentURL || '/'; // Retrieve the returnTo value from session
          delete req.session.returnTo; // Remove the returnTo value from session
          console.log(returnTo)
          res.redirect(returnTo);
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

  app.get('/admin/results/*', secured,fixture_controller.fixture_detail_byDivision);
  app.get('/admin/results/:division/:season',  secured,fixture_controller.fixture_detail_byDivision);
  app.get('/club/:id', secured,club_controller.club_detail);
  
  app.get('/players/club-:club?/team-:team?/gender-:gender?', secured,player_controller.player_list_clubs_teams);
  app.get('/players/club-:club?', secured,player_controller.player_list_clubs_teams);
  app.get('/players/team-:team?', secured,player_controller.player_list_clubs_teams);
  app.get('/players/gender-:gender?', secured,player_controller.player_list_clubs_teams);
  app.get('/players', secured,player_controller.player_list_clubs_teams);
  app.get('/manage-players/club-:club?', secured,player_controller.manage_player_list_clubs_teams);
  app.get('/email-scorecard', secured,fixture_controller.email_scorecard);
  app.post('/email-scorecard', fixture_controller.validateScorecard, fixture_controller.fixture_populate_scorecard_errors);
  app.post('/add-scorecard-photo/:id',fixture_controller.add_scorecard_photo)
  

  /* GET request for creating a Player. NOTE This must come before routes that display Player (uses id) */
  app.get('/player/create', secured,player_controller.player_create_get);
  app.post('/player/batch-update',player_controller.player_batch_update);
  app.post('/player/:id',secured, player_controller.player_update_post);
  // TODO: Create page showing teams, venue, club night and match night details, player stats for the club, team registrations
  app.get('/club/:id', secured,club_controller.club_detail);
  app.get('/club-api/:id', secured,club_controller.club_detail_api);
  app.get('/admin/info/clubs', secured,club_controller.club_list_detail);

app.use(function(req, res) {
  res.status(404);
  res.render('404-error', {
      pageHeading: "404",
      pageTitle: "404",
      static_path: "/static",
      title : "Can't find the page your looking for",
      pageDescription : "Can't find the page your looking for",
      entry : "<p>Sorry can't find that page</p>"
 });
})

app.use(function(error, req, res) {
    res.status(500);
    res.render('500-error', {
        pageHeading: "500",
        pageTitle: "500",
        static_path: "/static",
        title : "Sorry - theres been an error",
        pageDescription : "Sorry - theres been an error",
        entry : "<p>Sorry there's been an error</p>"
   });
  })

module.exports = app