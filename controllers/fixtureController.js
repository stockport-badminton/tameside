let Fixture = require("../models/fixture");
let Division = require("../models/division");
let Team = require("../models/teams");
let Player = require("../models/players");
let Game = require("../models/game");
let HomepageContent = require("../models/homepageContent");
let SiteSettings = require("../models/siteSettings");
const ejs = require('ejs');
const ICAL = require("ical.js");
const mailjet = require ('node-mailjet').apiConnect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET)
// Test-only seam: exposes the same client instance the module calls into, so
// tests can stub `.post` (mock.method) instead of hitting the real Mailjet API.
exports._mailjetClientForTesting = mailjet;
const seasonModel = require("../models/season");

const { body, validationResult } = require("express-validator");
const { sanitizeBody } = require("express-validator");
const { hasWinner, hasValidMargin } = require("../utils/scorecardValidation");
// Shared with every other admin-gated controller — utils/authz.js owns the claim key.
const authz = require("../utils/authz");
const { isSuperAdmin } = authz;

const promisify = (fn) => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result))));

// Render the 404 page from inside a handler, for a URL that routed fine but names a
// fixture that isn't there. Now shared with teamController's Lewis route — see
// utils/render404.js for why the no-store header matters.
const render404 = require('../utils/render404');
// Absolute urls for emails and rel=canonical. NOT req.headers.host: Firebase Hosting
// rewrites Host to the Cloud Run hostname, so that produced *.a.run.app links, which
// break the Auth0 round trip — a different origin is a different cookie jar, so the
// session holding `returnTo` never comes back. See utils/siteUrl.js.
const { siteUrl, absoluteUrl, canonicalFor } = require('../utils/siteUrl');

const getDivisionsP = promisify(Division.getAllAndSelectedById);
const getTeamsP = promisify(Team.getAllAndSelectedById);
// getEligiblePlayersAndSelectedById takes its callback as the 5th arg, with
// the optional third/fourth player ids trailing after it — promisify()
// assumes the callback is last, so this one needs its own wrapper.
function getEligiblePlayersP(first, second, teamId, gender, third, fourth) {
  return new Promise((resolve, reject) => {
    Player.getEligiblePlayersAndSelectedById(
      first, second, teamId, gender,
      (err, result) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)),
      third, fourth
    );
  });
}

// express-validator adapters — applied to each away-score field, they pull the
// paired home score from the body and defer to the pure rules (returning a
// boolean: true = valid, false = validation fails).
function greaterThan21(value, { req, path }) {
  return hasWinner(req.body[path.replace("away", "home")], value);
}

function differenceOfTwo(value, { req, path }) {
  return hasValidMargin(req.body[path.replace("away", "home")], value);
}

// Card order (1-18); the label is used in that game's validation messages,
// e.g. Game7awayScore fails with "First Mixed 1:...".
const GAME_LABELS = [
  "First Mens 1", "First Mens 2",
  "First Ladies 1", "First Ladies 2",
  "Second Mens 1", "Second Mens 2",
  "First Mixed 1", "First Mixed 2",
  "Second Mixed 1", "Second Mixed 2",
  "Third Mixed 1", "Third Mixed 2",
  "Fourth Mixed 1", "Fourth Mixed 2",
  "Third Mens 1", "Third Mens 2",
  "Fourth Mens 1", "Fourth Mens 2",
];

function gameScoreValidators(gameNumber, label) {
  return [
    body(`Game${gameNumber}homeScore`)
      .isInt({ min: 0, max: 30 })
      .withMessage("must be between 0 and 30"),
    body(`Game${gameNumber}awayScore`)
      .isInt({ min: 0, max: 30 })
      .withMessage("must be between 0 and 30")
      .custom(differenceOfTwo)
      .withMessage(`${label}:winning score isn't 2 greater than losing score`)
      .custom(greaterThan21)
      .withMessage(`${label}:one of the teams needs to score at least 21`),
  ];
}

// A player field can't hold the same player as any other field in its group
// (0 means "no player chosen", so it's exempt from the duplicate check).
function noDuplicatePlayerValidator(field, group, label) {
  return body(field, "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      if (value == 0) return false;
      return !group.some((other) => other !== field && value == req.body[other]);
    })
    .withMessage(`${label}: can't use the same player more than once`);
}

const MEN_FIELDS = ["homeMan1", "homeMan2", "homeMan3", "homeMan4", "awayMan1", "awayMan2", "awayMan3", "awayMan4"];
const LADY_FIELDS = ["homeLady1", "homeLady2", "awayLady1", "awayLady2"];
const FIELD_LABELS = {
  homeMan1: "Home Man 1", homeMan2: "Home Man 2", homeMan3: "Home Man 3", homeMan4: "Home Man 4",
  awayMan1: "Away Man 1", awayMan2: "Away Man 2", awayMan3: "Away Man 3", awayMan4: "Away Man 4",
  homeLady1: "Home Lady 1", homeLady2: "Home Lady 2",
  awayLady1: "Away Lady 1", awayLady2: "Away Lady 2",
};

// The Mixed events reuse the singles players; these hidden fields carry
// those picks along and are checked for dupes within their own side only.
const HOME_MIXED_MAN_FIELDS = ["FirstMixedhomeMan1", "SecondMixedhomeMan2", "ThirdMixedhomeMan3", "FourthMixedhomeMan4"];
const AWAY_MIXED_MAN_FIELDS = ["FirstMixedawayMan1", "SecondMixedawayMan2", "ThirdMixedawayMan3", "FourthMixedawayMan4"];
const MIXED_MAN_LABELS = {
  FirstMixedhomeMan1: "First Mixed Home Man", SecondMixedhomeMan2: "Second Mixed Home Man",
  ThirdMixedhomeMan3: "Third Mixed Home Man", FourthMixedhomeMan4: "Fourth Mixed Home Man",
  FirstMixedawayMan1: "First Mixed Away Man", SecondMixedawayMan2: "Second Mixed Away Man",
  ThirdMixedawayMan3: "Third Mixed Away Man", FourthMixedawayMan4: "Fourth Mixed Away Man",
};
const MIXED_LADY_FIELDS = [
  "FirstMixedhomeLady1", "SecondMixedhomeLady2", "ThirdMixedhomeLady1", "FourthMixedhomeLady2",
  "FirstMixedawayLady1", "SecondMixedawayLady2", "ThirdMixedawayLady1", "FourthMixedawayLady2",
];

exports.validateScorecard = [
  body("division").notEmpty().withMessage("Please choose a division."),
  body("date").isISO8601().withMessage("Please choose a valid date."),
  body("homeTeam").notEmpty().withMessage("Please choose a home team."),
  body("awayTeam")
    .notEmpty()
    .withMessage("Please choose an away team.")
    .bail()
    .custom((value, { req }) => value != req.body.homeTeam)
    .withMessage("Home team and away team can't be the same."),
  ...GAME_LABELS.flatMap((label, i) => gameScoreValidators(i + 1, label)),
  ...MEN_FIELDS.map((f) => noDuplicatePlayerValidator(f, MEN_FIELDS, FIELD_LABELS[f])),
  ...LADY_FIELDS.map((f) => noDuplicatePlayerValidator(f, LADY_FIELDS, FIELD_LABELS[f])),
  ...HOME_MIXED_MAN_FIELDS.map((f) => noDuplicatePlayerValidator(f, HOME_MIXED_MAN_FIELDS, MIXED_MAN_LABELS[f])),
  ...AWAY_MIXED_MAN_FIELDS.map((f) => noDuplicatePlayerValidator(f, AWAY_MIXED_MAN_FIELDS, MIXED_MAN_LABELS[f])),
  ...MIXED_LADY_FIELDS.map((f) => body(f, "Please choose a player.").isInt()),
];

exports.fixture_get_summary = function(req, res,next) {
  Fixture.getOutstandingScorecards(function(err,scorecards){
    if (err){
      console.log(err);
      next(err);
    }
    else {
  Fixture.getRecent(function(err,recentResults){
    if (err){
      console.log(err);
      next(err);
    }
    else{
      Fixture.getupComing(function(err,upcomingFixtures){
        if (err){
          console.log(err);
          next(err);
        }
        else{
          HomepageContent.getActive(function(err,announcements){
            if (err){
              console.log(err);
              next(err);
              return;
            }
            SiteSettings.get('homepage_gallery_tag', function(err,galleryTag){
              if (err){
                console.log(err);
                galleryTag = undefined;
              }
              const renderHomepage = function(assets){
                res.render('homepage', {
                    static_path: '/static',
                    title : "Homepage",
                    pageDescription : "Clubs: Aerospace, College Green, Disley, GHAP, Hyde, Manchester Edgeley, Manor, Mellor, Medlock, Shell. Social and Competitive badminton in and around Tameside.",
                    result : recentResults,
                    row : upcomingFixtures,
                    scorecards:scorecards,
                    announcements : announcements,
                    assets : assets
                });
              }
              fetch('https://api.cloudinary.com/v1_1/hvunsveuh/resources/image/tags/' + encodeURIComponent(galleryTag || 'messer2024') + '?max_results=30&context=true', {
                headers: { 'Authorization': 'Basic ' + process.env.CLOUDINARY_AUTH }
              })
              .then(r => r.json())
              .then(function(assets){
                renderHomepage(assets.resources)
              })
              // A Cloudinary failure must never take the homepage down —
              // render with an empty gallery instead of hanging the request.
              .catch(function(){ renderHomepage([]) })
            })
          })
      }
    })
  }
})
}
})
};


exports.fixture_detail_byDivision = function (req, res, next) {
  console.log(req.user);
  let divisionString = "";
  let searchObj = {};
  if (req.params.division !== undefined) {
    console.log(req.params);
    divisionString = req.params.division.replace("-", " ");
    Division.getIdByURLParam(req.params.division, function (err, row) {
      if (row.length < 1) {
        delete req.params.division;
        searchObj = req.params;
      } else {
        searchObj = req.params;
        searchObj.division = row[0].id;
      }
      Fixture.getFixtureDetails(searchObj, function (err, result) {
        if (err) {
          next(err);
        } else {
          let today = new Date()
          today.setHours(0, 0, 0, 0);
          // Which fixture the table should open on: the next one due, or the most
          // recent if they're all in the past (`result` is date-ascending).
          //
          // A filter combination can legitimately match no fixtures at all - a club
          // with none in the chosen season, a status nothing currently has - and then
          // result[result.length - 1] is undefined. Reading .date off it threw, and
          // because this runs in a model callback rather than the request chain, the
          // throw escaped Express and took the whole process down instead of
          // rendering an empty table. Leave nearestDate unset in that case;
          // datatables.ejs already falls back to today when it's missing.
          let upcomingFixtures = result.filter(row => new Date(row.date) >= today);
          let nearestFixture = upcomingFixtures.length
            ? upcomingFixtures[0]
            : result[result.length - 1];
          var type = "";
          var jsonResult = "";
          // console.log(req.path);
          let divisionsArray = result
            .map((row) => row.division)
            .filter((division, index, arr) => arr.indexOf(division) == index);
          let griddedData = [];
          for (division of divisionsArray) {
            // console.log(division);
            let gridFixtures = result.filter(
              (row) =>
                row.division == division &&
                row.status != "rearranged" &&
                row.id != 99999
            );
            // console.log(gridFixtures);
            gridFixtures.sort(function (x, y) {
              return (
                x.homeTeam.localeCompare(y.homeTeam) ||
                x.awayTeam.localeCompare(y.awayTeam)
              );
            });
            let gridTeams = gridFixtures
              .map((p) => p.homeTeam)
              .filter((homeTeam, index, arr) => arr.indexOf(homeTeam) == index);
            let gridDataElem = {};
            gridDataElem.teams = gridTeams;
            gridDataElem.fixtures = gridFixtures;
            gridDataElem.division =
              division == 7
                ? "Prem"
                : division == 8
                ? "Division 1"
                : division == 9
                ? "Division 2"
                : "Division 3";
            griddedData.push(gridDataElem);
          }
          // console.log(griddedData);
          if (req.path.indexOf("results-grid") > -1) {
            type = "-grid";
            jsonResult = JSON.stringify(griddedData);
          }
          res.status(200);
          console.log(division);
          let renderObject = {
            static_path: "/static",
            title: "Fixtures & Results: " + divisionString,
            pageDescription:
              "Find out how the teams in your division have got on, and check when your next match is",
            result: result,
            jsonResult: griddedData,
            error: false,
            division: divisionString,
            nearestDate: nearestFixture ? nearestFixture.date : undefined
          };
          // `admin` is "has any site role", `superadmin` is the stronger one — the
          // view branches on both. Neither is set for a user with no role, so the
          // template's `typeof superadmin !== 'undefined'` guards still hold.
          if (req.path.search("admin") != -1 && authz.role(req) !== undefined) {
            renderObject.admin = true;
            renderObject.superadmin = authz.isSuperAdmin(req);
            renderObject.user = req.user;
          }
          res.render("fixtures-results" + type, renderObject);
        }
      });
    });
  } else {
    // console.log(Object.entries(req.params))
    var convertedParams = req.params[0]
      .replace("Premier", "division-7")
      .replace("Division 1", "division-8")
      .replace("Division-1", "division-8")
      .replace("Division 2", "division-9")
      .replace("Division-2", "division-9")
      .replace("Division 3", "division-10")
      .replace("Division-3", "division-10")
      .replace(/(\/)(20\d\d20\d\d)/g, "$1season-$2");
    const pattern = /(\bPremier(?!\s|-\d)|Division(?:-|\s))(\d+)/g;
    // Finding matches using regex and replacing them
    const replacedMatches = [];
    const replacedString = req.params[0].replace(pattern, (match, p1, p2) => {
      let replacedMatch;
      if (p1 === "Premier") {
        replacedMatch = p1;
      } else {
        replacedMatch = `${p1.replace("-", " ")}${p2}`;
      }
      replacedMatches.push(replacedMatch);
      return replacedMatch;
    });
    let divisionString = "All";
    if (replacedMatches.length > 0) {
      divisionString = replacedMatches[0];
    }

    // console.log(regexParams)
    var searchArray = convertedParams.split("/");
    let searchObj = searchArray.reduce((acc, str) => {
      const [key, value] = str.split("-");
      return { ...acc, [key]: value };
    }, {});
    // Only the /admin view is club-scoped; the public results pages show everything.
    if (req.path.search("admin") != -1) {
      authz.scopeToAdminClub(req, searchObj);
    }
 // console.log(searchObj);
    Fixture.getFixtureDetails(searchObj, function (err, result) {
      if (err) {
        next(err);
      } else {
        let today = new Date()
        today.setHours(0, 0, 0, 0);
        // Same as the branch above: next fixture due, else the most recent, else
        // none at all when the filters match nothing. See the comment there.
        let upcomingFixtures = result.filter(row => new Date(row.date) >= today);
        let nearestFixture = upcomingFixtures.length
          ? upcomingFixtures[0]
          : result[result.length - 1];
        var type = "";
        var jsonResult = "";
        // console.log(req.path);
        let divisionsArray = result
          .map((row) => row.division)
          .filter((division, index, arr) => arr.indexOf(division) == index);
        // console.log(divisionsArray)
        let griddedData = [];
        for (division of divisionsArray) {
          // console.log(division);
          let gridFixtures = result.filter(
            (row) =>
              row.division == division &&
              row.status != "rearranged" &&
              row.id != 99999
          );
          // console.log(gridFixtures)
          gridFixtures.sort(function (x, y) {
            return (
              x.homeTeam.localeCompare(y.homeTeam) ||
              x.awayTeam.localeCompare(y.awayTeam)
            );
          });
          let gridTeams = gridFixtures
            .map((p) => p.homeTeam)
            .filter((homeTeam, index, arr) => arr.indexOf(homeTeam) == index);
          let gridDataElem = {};
          gridDataElem.teams = gridTeams;
          gridDataElem.fixtures = gridFixtures;
          gridDataElem.division =
            division == 7
              ? "Prem"
              : division == 8
              ? "Division 1"
              : division == 9
              ? "Division 2"
              : "Division 3";
          griddedData.push(gridDataElem);
        }
        // console.log(griddedData);
        if (req.path.indexOf("results-grid") > -1) {
          type = "-grid";
          jsonResult = JSON.stringify(griddedData);
          // console.log(jsonResult)
        }
        let titleString = "";
        if (searchObj !== undefined) {
          let filterArray = ["season", "division", "club", "team"];

          for (filter of filterArray) {
 // console.log(filter);
 // console.log(Object.entries(searchObj));
            let sqlParams = Object.entries(searchObj).filter(
              (obj) => obj[0] === filter
            );
            if (sqlParams.length > 0) {
              titleString += sqlParams[0][1];
              titleString += " ";
 // console.log("titleString:" + titleString);
            }
          }
        }
        // console.log(result)
        let clubs = result.map(item => item.homeClub).filter((value, index, self) => self.indexOf(value) === index) 
        let teams = result.map(item => item.homeTeam).filter((value, index, self) => self.indexOf(value) === index)         
        // console.log(clubs)
        // console.log(teams)
        let renderObject = {
          path: req.path,
          user: req.user,
          static_path: "/static",
          title: "Fixtures & Results: " + titleString,
          pageDescription:
            "Find out how the teams in your division have got on, and check when your next match is",
          result: result,
          clubs:clubs,
          teams:teams,
          filter:true,
          hideFilters:["gender","gametype"],
          jsonResult: griddedData,
          error: false,
          division: divisionString,
          nearestDate: nearestFixture ? nearestFixture.date : undefined
        };
        if (req.path.search("admin") != -1 && authz.role(req) !== undefined) {
          renderObject.admin = true;
          renderObject.superadmin = authz.isSuperAdmin(req);
          renderObject.user = req.user;
        }
        if (req.path.indexOf("fixtures") > -1) {
          res.status(200);
          res.send(result);
        }
        else{
          res.status(200);
        res.render("fixtures-results" + type, renderObject);
        }
        
      }
    });
  }
};

exports.fixture_calendars = function (req, res, next) {
  // console.log(Object.entries(req.params))
  var convertedParams = req.params[0]
    .replace("Premier", "division-7")
    .replace("Division 1", "division-8")
    .replace("Division-1", "division-8")
    .replace("Division 2", "division-9")
    .replace("Division-2", "division-9")
    .replace("Division 3", "division-10")
    .replace("Division-3", "division-10")
    .replace(/(\/)(20\d\d20\d\d)/g, "$1season-$2");
  const pattern = /(\bPremier(?!\s|-\d)|Division(?:-|\s))(\d+)/g;
  // Finding matches using regex and replacing them
  const replacedMatches = [];
  const replacedString = req.params[0].replace(pattern, (match, p1, p2) => {
    let replacedMatch;
    if (p1 === "Premier") {
      replacedMatch = p1;
    } else {
      replacedMatch = `${p1.replace("-", " ")}${p2}`;
    }
    replacedMatches.push(replacedMatch);
    return replacedMatch;
  });
  let divisionString = "All";
  if (replacedMatches.length > 0) {
    divisionString = replacedMatches[0];
  }
  // console.log(regexParams)
  var searchArray = convertedParams.split("/");
  let searchObj = searchArray.reduce((acc, str) => {
    const [key, value] = str.split("-");
    return { ...acc, [key]: value };
  }, {});
 // console.log(searchObj);
  Fixture.getFixtureDetails(searchObj, function (err, result) {
    if (err) {
      next(err);
    } else {
      // console.log(result)
      let id =
        (searchObj.season != undefined ? searchObj.season : seasonModel.current()) +
        (searchObj.division != undefined ? searchObj.division : "") +
        (searchObj.club != undefined ? searchObj.club : "") +
        (searchObj.team != undefined ? searchObj.team : "");

      const jcal = new ICAL.Component("vcalendar");
      jcal.addPropertyWithValue(
        "prodid",
        (searchObj.season != undefined ? searchObj.season : seasonModel.current()) +
          "/" +
          (searchObj.division != undefined ? searchObj.division : "") +
          "/" +
          (searchObj.club != undefined ? searchObj.club : "") +
          "/" +
          (searchObj.team != undefined ? searchObj.team : "")
      );
      jcal.addPropertyWithValue("version", "2.0");
      const vcalendar = jcal;

      // Iterate over each event and convert it to an iCalendar event
      result.forEach((row) => {
        let MyDate = new Date(row.date);

        let startDate =
          MyDate.getFullYear() +
          ("0" + (MyDate.getMonth() + 1)).slice(-2) +
          ("0" + MyDate.getDate()).slice(-2);
        let endDate =
          MyDate.getFullYear() +
          ("0" + (MyDate.getMonth() + 1)).slice(-2) +
          ("0" + (MyDate.getDate() + 1)).slice(-2);
        const vevent = new ICAL.Component("vevent");
        vevent.addPropertyWithValue("uid", row.id.toString());
        vevent.addPropertyWithValue(
          "summary",
          row.hometeam + " vs " + row.awayteam
        );
        vevent.addPropertyWithValue("dtstart;value=date", startDate);
        vevent.addPropertyWithValue("dtend;value=date", endDate);
        vevent.addPropertyWithValue(
          "location",
          row.venuename + " " + row.venuelink
        );

        // Add other properties if needed

        vcalendar.addSubcomponent(vevent);
      });

      // Convert the iCalendar object to a string
      const icsData = jcal.toString();

      // Set the response headers
      res.setHeader("Content-Type", "text/calendar");
      res.setHeader("Content-Disposition", `attachment; filename=${id}.ics`);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("ETag", id + new Date().toUTCString()); // Update the ETag value when the calendar data changes
      res.setHeader("Last-Modified", new Date().toUTCString());

      // Send the iCalendar data as the response
      res.send(icsData);

      // res.status(200);
      // res.send(calendarJSON)
    }
  });
};

exports.email_scorecard = function (req, res, next) {
  Division.getAllByLeague(1, function (err, rows) {
    if (err) {
      return next(err);
    }
    function renderWithEmail(email) {
      Fixture.getMissingScorecardPhotos(email, function (err, fixtures) {
        if (err) {
          return next(err);
        }
        res.render("email-scorecard", {
          static_path: "/static",
          theme: process.env.THEME || "flatly",
          title: "Scorecard",
          pageDescription: "Enter some results!",
          result: rows,
          fixtures: fixtures
        });
      });
    }

    // The logged-in user's email, which is all this page ever wanted. It used to
    // cost two Auth0 Management API round-trips (fetch a token, then look the user
    // up by id) for a value passport already put on req.user at login — plus a
    // DEV_MODE branch that existed purely to skip those calls when there are no real
    // Auth0 credentials to make them with. Both are gone.
    //
    // Three shapes because passport-auth0 fills them inconsistently across identity
    // providers, and middleware/devMode.js's mock sets only the last one.
    const email = (req.user && req.user.emails && req.user.emails[0] && req.user.emails[0].value)
      || (req.user && req.user._json && req.user._json.email)
      || (req.user && req.user.email);

    if (!email) {
      // getMissingScorecardPhotos filters on it, so without an email this page would
      // silently show someone else's outstanding scorecards, or all of them.
      const noEmail = new Error("Could not determine your email address — try logging out and back in.");
      noEmail.status = 400;
      return next(noEmail);
    }

    return renderWithEmail(email);
  })
};

let msg = {}

exports.fixture_populate_scorecard_errors = function (req, res, next) {
  var errors = validationResult(req);
  // console.log(errors.array());
  if (!errors.isEmpty()) {
    let data = req.body;
    console.log(data);
    // A malformed/direct POST can omit these entirely; the DB helpers below
    // interpolate them straight into queries and postgres.js throws on
    // `undefined` params. 0 is this codebase's existing "nothing selected"
    // sentinel (see the validators' `value != 0` checks) so defaulting to it
    // here just renders the error form with nothing pre-selected instead of
    // crashing.
    [
      "division", "homeTeam", "awayTeam",
      "homeMan1", "homeMan2", "homeMan3", "homeMan4", "homeLady1", "homeLady2",
      "awayMan1", "awayMan2", "awayMan3", "awayMan4", "awayLady1", "awayLady2",
    ].forEach((field) => {
      if (data[field] === undefined) data[field] = 0;
    });

    // None of these 7 lookups depend on each other's results — they all read
    // straight from `data` — so they run concurrently instead of nested
    // serially. Wrapped in an IIFE (rather than making the whole exported
    // function async) so the untouched success branch below keeps Express's
    // built-in synchronous-throw handling.
    (async () => {
      let divisionRows, homeTeamRows, awayTeamRows, homeMenRows, homeLadiesRows, awayMenRows, awayLadiesRows;
      try {
        [divisionRows, homeTeamRows, awayTeamRows, homeMenRows, homeLadiesRows, awayMenRows, awayLadiesRows] =
          await Promise.all([
            getDivisionsP(1, data.division),
            getTeamsP(data.homeTeam, data.division),
            getTeamsP(data.awayTeam, data.division),
            getEligiblePlayersP(data.homeMan1, data.homeMan2, data.homeTeam, "Male", data.homeMan3, data.homeMan4),
            getEligiblePlayersP(data.homeLady1, data.homeLady2, data.homeTeam, "Female"),
            getEligiblePlayersP(data.awayMan1, data.awayMan2, data.awayTeam, "Male", data.awayMan3, data.awayMan4),
            getEligiblePlayersP(data.awayLady1, data.awayLady2, data.awayTeam, "Female"),
          ]);
      } catch (err) {
        return next(err);
      }

      res.render("email-scorecard", {
        static_path: "/static",
        title: "Spreadsheet Upload Scorecard",
        pageDescription: "Show result of uploading scorecard",
        scorecard: {
          divisionRows,
          homeTeamRows,
          awayTeamRows,
          homeMenRows,
          homeLadiesRows,
          awayMenRows,
          awayLadiesRows,
        },
        data: data,
        errors: errors.array(),
      });
    })();
  } else {
    let scorecardUrl = absoluteUrl(
      "/populated-scorecard/" +
      req.body.division +
      "/" +
      req.body.homeTeam +
      "/" +
      req.body.awayTeam +
      "/" +
      req.body.homeMan1 +
      "/" +
      req.body.homeMan2 +
      "/" +
      req.body.homeMan3 +
      "/" +
      req.body.homeMan4 +
      "/" +
      req.body.homeLady1 +
      "/" +
      req.body.homeLady2 +
      "/" +
      req.body.awayMan1 +
      "/" +
      req.body.awayMan2 +
      "/" +
      req.body.awayMan3 +
      "/" +
      req.body.awayMan4 +
      "/" +
      req.body.awayLady1 +
      "/" +
      req.body.awayLady2 +
      "/" +
      req.body.Game1homeScore +
      "/" +
      req.body.Game1awayScore +
      "/" +
      req.body.Game2homeScore +
      "/" +
      req.body.Game2awayScore +
      "/" +
      req.body.Game3homeScore +
      "/" +
      req.body.Game3awayScore +
      "/" +
      req.body.Game4homeScore +
      "/" +
      req.body.Game4awayScore +
      "/" +
      req.body.Game5homeScore +
      "/" +
      req.body.Game5awayScore +
      "/" +
      req.body.Game6homeScore +
      "/" +
      req.body.Game6awayScore +
      "/" +
      req.body.Game7homeScore +
      "/" +
      req.body.Game7awayScore +
      "/" +
      req.body.Game8homeScore +
      "/" +
      req.body.Game8awayScore +
      "/" +
      req.body.Game9homeScore +
      "/" +
      req.body.Game9awayScore +
      "/" +
      req.body.Game10homeScore +
      "/" +
      req.body.Game10awayScore +
      "/" +
      req.body.Game11homeScore +
      "/" +
      req.body.Game11awayScore +
      "/" +
      req.body.Game12homeScore +
      "/" +
      req.body.Game12awayScore +
      "/" +
      req.body.Game13homeScore +
      "/" +
      req.body.Game13awayScore +
      "/" +
      req.body.Game14homeScore +
      "/" +
      req.body.Game14awayScore +
      "/" +
      req.body.Game15homeScore +
      "/" +
      req.body.Game15awayScore +
      "/" +
      req.body.Game16homeScore +
      "/" +
      req.body.Game16awayScore +
      "/" +
      req.body.Game17homeScore +
      "/" +
      req.body.Game17awayScore +
      "/" +
      req.body.Game18homeScore +
      "/" +
      req.body.Game18awayScore);
    let scorecardObj = {};
    scorecardObj.date = req.body.date;
    scorecardObj.division = req.body.division;
    scorecardObj.homeTeam = req.body.homeTeam;
    scorecardObj.awayTeam = req.body.awayTeam;
    scorecardObj.homeMan1 = req.body.homeMan1;
    scorecardObj.homeMan2 = req.body.homeMan2;
    scorecardObj.homeMan3 = req.body.homeMan3;
    scorecardObj.homeMan4 = req.body.homeMan4;
    scorecardObj.homeLady1 = req.body.homeLady1;
    scorecardObj.homeLady2 = req.body.homeLady2;
    scorecardObj.awayMan1 = req.body.awayMan1;
    scorecardObj.awayMan2 = req.body.awayMan2;
    scorecardObj.awayMan3 = req.body.awayMan3;
    scorecardObj.awayMan4 = req.body.awayMan4;
    scorecardObj.awayLady1 = req.body.awayLady1;
    scorecardObj.awayLady2 = req.body.awayLady2;
    scorecardObj.FirstMixedhomeMan1 = req.body.FirstMixedhomeMan1;
    scorecardObj.SecondMixedhomeMan2 = req.body.SecondMixedhomeMan2;
    scorecardObj.ThirdMixedhomeMan3 = req.body.ThirdMixedhomeMan3;
    scorecardObj.FourthMixedhomeMan4 = req.body.FourthMixedhomeMan4;
    scorecardObj.FirstMixedhomeLady1 = req.body.FirstMixedhomeLady1;
    scorecardObj.SecondMixedhomeLady2 = req.body.SecondMixedhomeLady2;
    scorecardObj.ThirdMixedhomeLady1 = req.body.ThirdMixedhomeLady1;
    scorecardObj.FourthMixedhomeLady2 = req.body.FourthMixedhomeLady2;
    scorecardObj.FirstMixedawayMan1 = req.body.FirstMixedawayMan1;
    scorecardObj.SecondMixedawayMan2 = req.body.SecondMixedawayMan2;
    scorecardObj.ThirdMixedawayMan3 = req.body.ThirdMixedawayMan3;
    scorecardObj.FourthMixedawayMan4 = req.body.FourthMixedawayMan4;
    scorecardObj.FirstMixedawayLady1 = req.body.FirstMixedawayLady1;
    scorecardObj.SecondMixedawayLady2 = req.body.SecondMixedawayLady2;
    scorecardObj.ThirdMixedawayLady1 = req.body.ThirdMixedawayLady1;
    scorecardObj.FourthMixedawayLady2 = req.body.FourthMixedawayLady2;
    scorecardObj.Game1homeScore = req.body.Game1homeScore;
    scorecardObj.Game1awayScore = req.body.Game1awayScore;
    scorecardObj.Game2homeScore = req.body.Game2homeScore;
    scorecardObj.Game2awayScore = req.body.Game2awayScore;
    scorecardObj.Game3homeScore = req.body.Game3homeScore;
    scorecardObj.Game3awayScore = req.body.Game3awayScore;
    scorecardObj.Game4homeScore = req.body.Game4homeScore;
    scorecardObj.Game4awayScore = req.body.Game4awayScore;
    scorecardObj.Game5homeScore = req.body.Game5homeScore;
    scorecardObj.Game5awayScore = req.body.Game5awayScore;
    scorecardObj.Game6homeScore = req.body.Game6homeScore;
    scorecardObj.Game6awayScore = req.body.Game6awayScore;
    scorecardObj.Game7homeScore = req.body.Game7homeScore;
    scorecardObj.Game7awayScore = req.body.Game7awayScore;
    scorecardObj.Game8homeScore = req.body.Game8homeScore;
    scorecardObj.Game8awayScore = req.body.Game8awayScore;
    scorecardObj.Game9homeScore = req.body.Game9homeScore;
    scorecardObj.Game9awayScore = req.body.Game9awayScore;
    scorecardObj.Game10homeScore = req.body.Game10homeScore;
    scorecardObj.Game10awayScore = req.body.Game10awayScore;
    scorecardObj.Game11homeScore = req.body.Game11homeScore;
    scorecardObj.Game11awayScore = req.body.Game11awayScore;
    scorecardObj.Game12homeScore = req.body.Game12homeScore;
    scorecardObj.Game12awayScore = req.body.Game12awayScore;
    scorecardObj.Game13homeScore = req.body.Game13homeScore;
    scorecardObj.Game13awayScore = req.body.Game13awayScore;
    scorecardObj.Game14homeScore = req.body.Game14homeScore;
    scorecardObj.Game14awayScore = req.body.Game14awayScore;
    scorecardObj.Game15homeScore = req.body.Game15homeScore;
    scorecardObj.Game15awayScore = req.body.Game15awayScore;
    scorecardObj.Game16homeScore = req.body.Game16homeScore;
    scorecardObj.Game16awayScore = req.body.Game16awayScore;
    scorecardObj.Game17homeScore = req.body.Game17homeScore;
    scorecardObj.Game17awayScore = req.body.Game17awayScore;
    scorecardObj.Game18homeScore = req.body.Game18homeScore;
    scorecardObj.Game18awayScore = req.body.Game18awayScore;
    scorecardObj["scoresheet-url"] = req.body["scoresheet-url"];
    scorecardObj["email"] = req.body["email"];
    if (typeof scorecardObj.email === 'undefined'){
      scorecardObj.email = 'tameside.badders.results+missingemail@gmail.com'
    }
    if (typeof scorecardObj["scoresheet-url"] === 'undefined'){
      scorecardObj["scoresheet-url"] = 'https://badmintontemp.s3.eu-west-1.amazonaws.com/tameside-'+req.body.homeTeam.replaceAll(' ','+')+'-'+req.body.awayTeam.replaceAll(' ','+')+'.jpg'
    }
    Fixture.createScorecard(scorecardObj, function (err, rows) {
      if (err) {
        console.log(err);
        next(err);
      } else {
 // console.log(rows);
        let scorecardUrlBeta =
          absoluteUrl("/populated-scorecard-beta/" + rows[0].id);
        // The photo link the results secretary gets. It used to be the raw public S3
        // URL, which meant the authorization on a scorecard photo was "know the URL",
        // for anyone this email was ever forwarded to — and it breaks outright once the
        // shared bucket's public ACLs are stripped. /scorecard-photo/:id is `secured`,
        // so the recipient sees it as themselves or gets sent to log in.
        let photoUrl = absoluteUrl("/scorecard-photo/" + rows[0].id);
        msg = {
            "From": {
              "Email": "results@tameside-badminton.co.uk"
            },
            "ReplyTo": {
              "Email": "tameside.badders.results@gmail.com"
            },
            "To": [
              {
                "Email": "tameside.badders.results@gmail.com"
              }
            ],
            "Bcc": [
              {
                "Email": "tameside.badders.results@gmail.com"
              }
            ],
            "Subject": "scorecard received",
            "TextPart": `a new scorecard has been uploaded: ${photoUrl} check the result here: ${scorecardUrl}`,
            "HTMLPart": `<p>a new scorecard has been uploaded: <a href="${photoUrl}">View the scorecard photo</a><br />Check the result here: <a href="${scorecardUrl}">Confirm</a> or <a href="${scorecardUrlBeta}">${scorecardUrlBeta}</a></p>`,
            
          }
        };
        const request = mailjet
          .post("send", {'version': 'v3.1'})
          .request({
          "Messages":[msg]})
          .then(() => {
 // console.log(msg);
            res.render("email-scorecard", {
              static_path: "/static",
              theme: process.env.THEME || "flatly",
              flask_debug: process.env.FLASK_DEBUG || "false",
              title:
                "Tameside Badminton League Scorecard Upload",
              pageDescription: "Upload your scorecard and send to the website",
              scorecard: req.body,
              // The row id, so the view can point at /scorecard-photo/:id instead of
              // the public bucket URL in req.body. `scorecard` is req.body and has no id.
              scorecardId: rows[0].id,
            });
          })
          .catch((error) => {
            console.log(error.toString());
            next(
              "Sorry something went wrong sending your scoresheet to the admin - drop him an email."
            );
          });
      })
    };
  }

exports.fixture_populate_scorecard_fromId = function (req, res, next) {
  Fixture.getScorecardById(req.params.id, (err, rows) => {
    if (err) {
      console.log(err);
      next(err);
    } else {
      Division.getAllAndSelectedById(
        1,
        rows[0].division,
        function (err, divisionRows) {
          if (err) {
            next(err);
          } else {
            // console.log(divisionIdRows)
            Team.getAllAndSelectedById(
              rows[0].homeTeam,
              rows[0].division,
              function (err, homeTeamRows) {
                if (err) {
                  next(err);
                } else {
                  // console.log(homeTeamRows)
                  Team.getAllAndSelectedById(
                    rows[0].awayTeam,
                    rows[0].division,
                    function (err, awayTeamRows) {
                      if (err) {
                        next(err);
                      } else {
                        // console.log(awayTeamRows)
                        Player.getEligiblePlayersAndSelectedById(
                          rows[0].homeMan1,
                          rows[0].homeMan2,
                          rows[0].homeTeam,
                          "Male",
                          function (err, homeMenRows) {
                            if (err) {
                              next(err);
                            } else {
                              // console.log(homeMenRows)
                              Player.getEligiblePlayersAndSelectedById(
                                rows[0].homeLady1,
                                rows[0].homeLady2,
                                rows[0].homeTeam,
                                "Female",
                                function (err, homeLadiesRows) {
                                  if (err) {
                                    next(err);
                                  } else {
                                    // console.log(homeLadiesRows)
                                    Player.getEligiblePlayersAndSelectedById(
                                      rows[0].awayMan1,
                                      rows[0].awayMan2,
                                      rows[0].awayTeam,
                                      "Male",
                                      function (err, awayMenRows) {
                                        if (err) {
                                          next(err);
                                        } else {
                                          // console.log(awayMenRows)
                                          Player.getEligiblePlayersAndSelectedById(
                                            rows[0].awayLady1,
                                            rows[0].awayLady2,
                                            rows[0].awayTeam,
                                            "Female",
                                            function (err, awayLadiesRows) {
                                              if (err) {
                                                next(err);
                                              } else {
                                                // console.log(awayLadiesRows)
                                                var renderData = {
                                                  divisionRows: divisionRows,
                                                  homeTeamRows: homeTeamRows,
                                                  awayTeamRows: awayTeamRows,
                                                  homeMenRows: homeMenRows,
                                                  homeLadiesRows:
                                                    homeLadiesRows,
                                                  awayMenRows: awayMenRows,
                                                  awayLadiesRows:
                                                    awayLadiesRows,
                                                };
                                                // console.log(renderData);
 // console.log(renderData);

                                                res.render(
                                                  "populated-scorecard",
                                                  {
                                                    static_path: "/static",
                                                    title:
                                                      "Spreadsheet Upload Scorecard",
                                                    pageDescription:
                                                      "Show result of uploading scorecard",
                                                    result: renderData,
                                                    data: rows[0],
                                                  }
                                                );
                                              }
                                            }
                                          );
                                        }
                                      },
                                      rows[0].awayMan3,
                                      rows[0].awayMan4,
                                    );
                                  }
                                }
                              );
                            }
                          },
                          rows[0].homeMan3,
                          rows[0].homeMan4
                        );
                      }
                    }
                  );
                }
              }
            );
            // console.log(data);
          }
        }
      );
    }
  });

  //TODO tidy the chain below up
};

// Display detail page for a specific Fixture
// GET /scorecard/fixture/:id
//
// getScorecardDataById INNER JOINs `game`, so it returns nothing for a fixture with no
// per-game rows — 366 of 652 fixtures. viewScorecard.ejs read result[0].date straight
// off the empty array, so all of them threw while rendering (Sentry TAMESIDE-NODE-3).
// Fixture 5704 is typical, and shows this isn't only an archive problem: a conceded
// 2025-26 match, 18-0, no games. Conceded and void fixtures happen every season.
//
// The header and the games are now separate locals, so a fixture with no game detail
// still shows what the match was and how it finished.
exports.getScorecard = function(req, res,next) {
  Fixture.getScorecardDataById(req.params.id, function(err,games){
    if (err){
      // Was res.send(err), which answered 200 with a serialised error object — a real
      // failure looked like a success to the browser and to monitoring.
      return next(err);
    }

    const render = (summary) => res.render('viewScorecard', {
      static_path: '/static',
      title : "Scorecard Info",
      pageDescription : "View scorecard for this match",
      result: games,
      summary: summary,
      canonical: canonicalFor(req)
    });

    if (games.length){
      // Every game row repeats the fixture-level columns, so take the header from the
      // first and save a second query on the common path.
      return render({
        date: games[0].date,
        homeTeam: games[0].homeTeam,
        awayTeam: games[0].awayTeam,
        homeScore: games[0].totalHomeScore,
        awayScore: games[0].totalAwayScore,
      });
    }

    // No games. Fall back to the summary query, which LEFT JOINs and so distinguishes
    // "no game detail" from "no such fixture" — the reason it exists rather than reusing
    // getFixtureEventById, whose inner joins answer zero rows for both.
    Fixture.getFixtureSummaryById(req.params.id, function(summaryErr,fixture){
      if (summaryErr){
        return next(summaryErr);
      }
      if (!fixture.length){
        return render404(req, res);
      }
      return render(fixture[0]);
    })
  })
};

exports.fixture_populate_scorecard_fromUrl = function(req,res,next){
  //console.log(data);
  //console.log(data.date);
 // console.log(req.params);
  
  let data = req.params;
  //TODO tidy the chain below up
  Division.getAllAndSelectedById(1,data.division,function(err,divisionRows){
    if(err){
      next(err)
    }
        else{
          // console.log(divisionIdRows)
          Team.getAllAndSelectedById(data.home_team,data.division,function(err,homeTeamRows){
            if (err) {
              next(err)
            }
            else{
              // console.log(homeTeamRows)
              Team.getAllAndSelectedById(data.away_team,data.division,function(err,awayTeamRows){
                if (err) {
                  next(err)
                }
                else{
                  // console.log(awayTeamRows)
                  Player.getEligiblePlayersAndSelectedById(data.home_man_1,data.home_man_2,data.home_team,'Male',function(err,homeMenRows){
                    if(err){
                      next(err)
                    }
                    else{
                      // console.log(homeMenRows)
                      Player.getEligiblePlayersAndSelectedById(data.home_lady_1,data.home_lady_2,data.home_team,'Female',function(err,homeLadiesRows){
                        if(err){
                          next(err)
                        }
                        else{
                          // console.log(homeLadiesRows)
                          Player.getEligiblePlayersAndSelectedById(data.away_man_1,data.away_man_2,data.away_team,'Male',function(err,awayMenRows){
                            if(err){
                              next(err)
                            }
                            else{
                              // console.log(awayMenRows)
                              Player.getEligiblePlayersAndSelectedById(data.away_lady_1,data.away_lady_2,data.away_team,'Female',function(err,awayLadiesRows){
                                if(err){
                                  next(err)
                                }
                                else{
                                  // console.log(awayLadiesRows)
                                  var renderData = {
                                    "divisionRows":divisionRows,
                                    "homeTeamRows":homeTeamRows,
                                    "awayTeamRows":awayTeamRows,
                                    "homeMenRows":homeMenRows,
                                    "homeLadiesRows":homeLadiesRows,
                                    "awayMenRows":awayMenRows,
                                    "awayLadiesRows":awayLadiesRows
                                  };
 // console.log(renderData);
                                  res.render('populated-scorecard', {
                                      static_path: '/static',
                                      title : "Spreadsheet Upload Scorecard",
                                      pageDescription : "Show result of uploading scorecard",
                                      result : renderData,
                                      data : data
                                  });
                                }
                            })
                          }
                        },data.away_man_3,data.away_man_4)
                      }
                    })
                  }
                },data.home_man_3,data.home_man_4)
              }
            })
          }
        })
        // console.log(data);
      }
    })
  }

  exports.full_fixture_post = function(req,res,next){
    var errors = validationResult(req);
    // console.log(errors.array());
    if (!errors.isEmpty()) {
      Division.getAllByLeague(1,function(err,rows){
        res.render('index-scorecard',{
          static_path:'/static',
          theme:process.env.THEME || 'flatly',
          title : "Scorecard Received - Errors",
          pageDescription : "Something went wrong",
          result:rows,
          errors: errors.array()
        })
      })
      
    }
    else {
      // console.log(req.body);
      // console.log(req.body);
      Fixture.getOutstandingFixtureId({homeTeam:req.body.homeTeam, awayTeam:req.body.awayTeam},async function(err,FixtureIdResult){
        if (err) {
          // console.log("getFixtureId sucess")
          // console.log(res)
          res.send(err);
        }
        else {
          // console.log("getFixtureId err")
          // console.log(res)
 // console.log(FixtureIdResult);
          var fixtureObject = {
            homeMan1 : req.body.homeMan1,
            homeMan2 : req.body.homeMan2,
            homeMan3 : req.body.homeMan3,
            homeMan4 : req.body.homeMan4,
            homeLady1 : req.body.homeLady1,
            homeLady2 : req.body.homeLady2,
            awayMan1 : req.body.awayMan1,
            awayMan2 : req.body.awayMan2,
            awayMan3 : req.body.awayMan3,
            awayMan4 : req.body.awayMan4,
            awayLady1 : req.body.awayLady1,
            awayLady2 : req.body.awayLady2,
            status:"complete",
            homeScore:req.body.homeScore,
            awayScore:req.body.awayScore
          }
          var prevScores = {}
          prevScores[req.body.homeMan1] = await Player.getPrevRating(req.body.homeMan1,req.body.date)
          prevScores[req.body.homeMan2] = await Player.getPrevRating(req.body.homeMan2,req.body.date)
          prevScores[req.body.homeMan3] = await Player.getPrevRating(req.body.homeMan3,req.body.date)
          prevScores[req.body.homeMan4] = await Player.getPrevRating(req.body.homeMan4,req.body.date)
          prevScores[req.body.homeLady1] = await Player.getPrevRating(req.body.homeLady1,req.body.date)
          prevScores[req.body.homeLady2] = await Player.getPrevRating(req.body.homeLady2,req.body.date)
          prevScores[req.body.awayMan1] = await Player.getPrevRating(req.body.awayMan1,req.body.date)
          prevScores[req.body.awayMan2] = await Player.getPrevRating(req.body.awayMan2,req.body.date)
          prevScores[req.body.awayMan3] = await Player.getPrevRating(req.body.awayMan3,req.body.date)
          prevScores[req.body.awayMan4] = await Player.getPrevRating(req.body.awayMan4,req.body.date)
          prevScores[req.body.awayLady1] = await Player.getPrevRating(req.body.awayLady1,req.body.date)
          prevScores[req.body.awayLady2] = await Player.getPrevRating(req.body.awayLady2,req.body.date)
          console.log(`prevScores: ${JSON.stringify(prevScores)}`)
          // console.log(fixtureObject);
          // TODO - fix this so that it doesn't break the website when no fixture matches the query
          Fixture.updateById(fixtureObject,FixtureIdResult[0].id,async function(err,fixResult){
            if (err) {
              console.log("updateById err")
              // console.log(res)
              res.send(err)
            }
            else {
 // console.log("updateById sucess")
              // console.log(res)
 // console.log(fixResult)
              var gameObject = {
                tablename:"game",
                fields:[
                  "homePlayer1", "homePlayer2", "awayPlayer1","awayPlayer2","homeScore","awayScore","fixture","gameType"
                ],
                data:[
                  {
                    homePlayer1:req.body.FirstMenshomeMan1,
                    homePlayer2:req.body.FirstMenshomeMan2,
                    awayPlayer1:req.body.FirstMensawayMan1,
                    awayPlayer2:req.body.FirstMensawayMan2,
                    homeScore:req.body.Game1homeScore,
                    awayScore:req.body.Game1awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FirstMens'
                  },
                  {
                    homePlayer1:req.body.FirstMenshomeMan1,
                    homePlayer2:req.body.FirstMenshomeMan2,
                    awayPlayer1:req.body.FirstMensawayMan1,
                    awayPlayer2:req.body.FirstMensawayMan2,
                    homeScore:req.body.Game2homeScore,
                    awayScore:req.body.Game2awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FirstMens'
                  },
                  {
                    homePlayer1:req.body.FirstLadieshomeLady1,
                    homePlayer2:req.body.FirstLadieshomeLady2,
                    awayPlayer1:req.body.FirstLadiesawayLady1,
                    awayPlayer2:req.body.FirstLadiesawayLady2,
                    homeScore:req.body.Game3homeScore,
                    awayScore:req.body.Game3awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FirstLadies'
                  },
                  {
                    homePlayer1:req.body.FirstLadieshomeLady1,
                    homePlayer2:req.body.FirstLadieshomeLady2,
                    awayPlayer1:req.body.FirstLadiesawayLady1,
                    awayPlayer2:req.body.FirstLadiesawayLady2,
                    homeScore:req.body.Game4homeScore,
                    awayScore:req.body.Game4awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FirstLadies'
                  },
                  {
                    homePlayer1:req.body.SecondMenshomeMan3,
                    homePlayer2:req.body.SecondMenshomeMan4,
                    awayPlayer1:req.body.SecondMensawayMan3,
                    awayPlayer2:req.body.SecondMensawayMan4,
                    homeScore:req.body.Game5homeScore,
                    awayScore:req.body.Game5awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'SecondMens'
                  },
                  {
                    homePlayer1:req.body.SecondMenshomeMan3,
                    homePlayer2:req.body.SecondMenshomeMan4,
                    awayPlayer1:req.body.SecondMensawayMan3,
                    awayPlayer2:req.body.SecondMensawayMan4,
                    homeScore:req.body.Game6homeScore,
                    awayScore:req.body.Game6awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'SecondMens'
                  },
                  {
                    homePlayer1:req.body.FirstMixedhomeMan1,
                    homePlayer2:req.body.FirstMixedhomeLady1,
                    awayPlayer1:req.body.FirstMixedawayMan1,
                    awayPlayer2:req.body.FirstMixedawayLady1,
                    homeScore:req.body.Game7homeScore,
                    awayScore:req.body.Game7awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FirstMixed'
                  },
                  {
                    homePlayer1:req.body.FirstMixedhomeMan1,
                    homePlayer2:req.body.FirstMixedhomeLady1,
                    awayPlayer1:req.body.FirstMixedawayMan1,
                    awayPlayer2:req.body.FirstMixedawayLady1,
                    homeScore:req.body.Game8homeScore,
                    awayScore:req.body.Game8awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FirstMixed'
                  },
                  {
                    homePlayer1:req.body.SecondMixedhomeMan2,
                    homePlayer2:req.body.SecondMixedhomeLady2,
                    awayPlayer1:req.body.SecondMixedawayMan2,
                    awayPlayer2:req.body.SecondMixedawayLady2,
                    homeScore:req.body.Game9homeScore,
                    awayScore:req.body.Game9awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'SecondMixed'
                  },
                  {
                    homePlayer1:req.body.SecondMixedhomeMan2,
                    homePlayer2:req.body.SecondMixedhomeLady2,
                    awayPlayer1:req.body.SecondMixedawayMan2,
                    awayPlayer2:req.body.SecondMixedawayLady2,
                    homeScore:req.body.Game10homeScore,
                    awayScore:req.body.Game10awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'SecondMixed'
                  },
                  {
                    homePlayer1:req.body.ThirdMixedhomeMan3,
                    homePlayer2:req.body.ThirdMixedhomeLady1,
                    awayPlayer1:req.body.ThirdMixedawayMan3,
                    awayPlayer2:req.body.ThirdMixedawayLady1,
                    homeScore:req.body.Game11homeScore,
                    awayScore:req.body.Game11awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'ThirdMixed'
                  },
                  {
                    homePlayer1:req.body.ThirdMixedhomeMan3,
                    homePlayer2:req.body.ThirdMixedhomeLady1,
                    awayPlayer1:req.body.ThirdMixedawayMan3,
                    awayPlayer2:req.body.ThirdMixedawayLady1,
                    homeScore:req.body.Game12homeScore,
                    awayScore:req.body.Game12awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'ThirdMixed'
                  },
                  {
                    homePlayer1:req.body.FourthMixedhomeMan4,
                    homePlayer2:req.body.FourthMixedhomeLady2,
                    awayPlayer1:req.body.FourthMixedawayMan4,
                    awayPlayer2:req.body.FourthMixedawayLady2,
                    homeScore:req.body.Game13homeScore,
                    awayScore:req.body.Game13awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FourthMixed'
                  },
                  {
                    homePlayer1:req.body.FourthMixedhomeMan4,
                    homePlayer2:req.body.FourthMixedhomeLady2,
                    awayPlayer1:req.body.FourthMixedawayMan4,
                    awayPlayer2:req.body.FourthMixedawayLady2,             
                    homeScore:req.body.Game14homeScore,
                    awayScore:req.body.Game14awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FourthMixed'
                  },
                  {
                    homePlayer1:req.body.ThirdMenshomeMan1,
                    homePlayer2:req.body.ThirdMenshomeMan2,
                    awayPlayer1:req.body.ThirdMensawayMan3,
                    awayPlayer2:req.body.ThirdMensawayMan4, 
                    homeScore:req.body.Game15homeScore,
                    awayScore:req.body.Game15awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'ThirdMens'
                  },
                  {
                    homePlayer1:req.body.ThirdMenshomeMan1,
                    homePlayer2:req.body.ThirdMenshomeMan2,
                    awayPlayer1:req.body.ThirdMensawayMan3,
                    awayPlayer2:req.body.ThirdMensawayMan4, 
                    homeScore:req.body.Game16homeScore,
                    awayScore:req.body.Game16awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'ThirdMens'
                  },
                  {
                    homePlayer1:req.body.FourthMenshomeMan3,
                    homePlayer2:req.body.FourthMenshomeMan4,
                    awayPlayer1:req.body.FourthMensawayMan1,
                    awayPlayer2:req.body.FourthMensawayMan2, 
                    homeScore:req.body.Game17homeScore,
                    awayScore:req.body.Game17awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FourthMens'
                  },
                  {
                    homePlayer1:req.body.FourthMenshomeMan3,
                    homePlayer2:req.body.FourthMenshomeMan4,
                    awayPlayer1:req.body.FourthMensawayMan1,
                    awayPlayer2:req.body.FourthMensawayMan2, 
                    homeScore:req.body.Game18homeScore,
                    awayScore:req.body.Game18awayScore,
                    fixture:FixtureIdResult[0].id,
                    gameType:'FourthMens'
                  }
                ]
              }
              // Lewis Shield (cup) fixtures don't count towards ELO: leave the
              // Start/End columns to their DB defaults (End = 0 = unrated).
              const isLewisFixture = FixtureIdResult[0].lewis_round != null
              if (!isLewisFixture){
                const fixtureRank = FixtureIdResult[0].rank
                for (game of gameObject.data){
                  const { updateObj } = Game.calculateRating(game, prevScores, req.body.date, fixtureRank)
                  Object.assign(game, updateObj)
                  for (const [pidKey, endKey] of [
                    ['homePlayer1', 'homePlayer1End'],
                    ['homePlayer2', 'homePlayer2End'],
                    ['awayPlayer1', 'awayPlayer1End'],
                    ['awayPlayer2', 'awayPlayer2End'],
                  ]){
                    const pid = game[pidKey]
                    if (pid && pid != 0 && prevScores[pid]){
                      prevScores[pid].rating = updateObj[endKey]
                      prevScores[pid].date = req.body.date
                    }
                  }
                }
              }
              console.log(gameObject)
              Game.createBatch(gameObject,function(err,gameResult){
                if (err){
                  console.log(`createBatch err: ${err}`)
                  // console.log(res)
                  res.send(err)
                }
                else {
 // console.log("createBatch sucess")
                  // Persist the updated player ratings (fire-and-forget so a
                  // failure never blocks the scorecard flow). updateBulk
                  // mutates its inputs, so build fresh arrays here.
                  if (!isLewisFixture){
                    const playerUpdate = {
                      tablename: 'player',
                      fields: ['id', 'rating'],
                      data: Object.entries(prevScores)
                        .filter(([id, p]) => parseInt(id, 10) > 0 && p && typeof p.rating !== 'undefined')
                        .map(([id, p]) => [parseInt(id, 10), 1 * p.rating])
                    }
                    if (playerUpdate.data.length > 0){
                      Player.updateBulk(playerUpdate, function(rateErr){
                        if (rateErr) console.error(`elo rating persist err: ${JSON.stringify(rateErr)}`)
                      })
                    }
                  }
                  Fixture.getFixtureDetailsById(FixtureIdResult[0].id,function(err,getFixtureDetailsResult){
                    if(err) res.send(err)
                    zapObject = {
                      // Canonical host, not req.headers.host — whatever consumes this
                      // webhook builds links from it.
                      "host":siteUrl().replace(/^https?:\/\//, ''),
                      "homeTeam":getFixtureDetailsResult[0].homeTeam,
                      "awayTeam":getFixtureDetailsResult[0].awayTeam,
                      "homeScore":getFixtureDetailsResult[0].homeScore,
                      "awayScore":getFixtureDetailsResult[0].awayScore,
                      "division":FixtureIdResult[0].name
                     }
                    // console.log(zapObject)
                     Fixture.sendResultZap(zapObject,function(err,zapRes){
                       if (err) res.send(err)
                      Player.getNominatedPlayers(getFixtureDetailsResult[0].homeTeam,function(err,homeTeamNomPlayers){
                        if (err) res.send(err)
                        Player.getNominatedPlayers(getFixtureDetailsResult[0].awayTeam,function(err,awayTeamNomPlayers){
                          if (err) res.send(err)
                          var searchObj = {};
                          searchObj.team = getFixtureDetailsResult[0].homeTeam
                          searchObj.limit = 4
                          Fixture.getMatchPlayerOrderDetails(searchObj,function(err,homeTeamFixturePlayers){
                            if (err) res.send(err)
                            var searchObj = {};
                            searchObj.team = getFixtureDetailsResult[0].awayTeam
                            searchObj.limit = 4
                            Fixture.getMatchPlayerOrderDetails(searchObj,function(err,awayTeamFixturePlayers){
                              if (err) res.send(err);
                              Player.getMatchStats(FixtureIdResult[0].id,function(err,matchStats){
                                if (err) res.send(err);                              
                                
                                var emailData = {                                
                                  "homeTeam":zapObject.homeTeam,
                                  "awayTeam":zapObject.awayTeam,
                                  "generatedImage":zapObject.homeTeam.replace(/([\s]{1,})/g,'-') + zapObject.awayTeam.replace(/([\s]{1,})/g,'-'),
                                  "matchStats":matchStats
                                }
                                // console.log(emailData);
                                ejs.renderFile('views/emails/websiteUpdated.ejs', {data:emailData}, function(err, str){
                                  if (err) console.log(err);
                                  console.log("logged in user email:" + req.body.email);
                                  msg = {
                                    "From": {
                                      "Email": "results@tameside-badminton.co.uk"
                                    },
                                    "ReplyTo": {
                                      "Email": "tameside.badders.results@gmail.com"
                                    },
                                    "To": [
                                      {
                                       "Email": (typeof req.body.email !== 'undefined' ? (req.body.email.indexOf('@') > 1 ? req.body.email : 'stockport.badders.results@gmail.com') : 'stockport.badders.results@gmail.com')
                                       //"Email":"tameside.badders.results@gmail.com"
                                      }
                                    ],
                                    "Bcc": [
                                      {
                                        "Email": "tameside.badders.results@gmail.com"
                                      }
                                    ],
                                    "Subject": "Website Updated: " + zapObject.homeTeam + " vs " + zapObject.awayTeam,
                                    "TextPart": "Thanks for sending your scorecard - website updated",
                                    "HTMLPart": str,
                                  }
                                const request = mailjet
                                  .post("send", {'version': 'v3.1'})
                                  .request({
                                  "Messages":[msg]})
                                  .then(()=>{                                
                                    res.render('index-scorecard',{
                                      static_path:'/static',
                                      theme:process.env.THEME || 'flatly',
                                      title : "Scorecard Received - No Errors",
                                      pageDescription : "Enter some results!",
                                      scorecardData: gameObject,
                                      homeTeamNomPlayers:homeTeamNomPlayers,
                                      awayTeamNomPlayers:awayTeamNomPlayers,
                                      homeTeamFixturePlayers:homeTeamFixturePlayers,
                                      awayTeamFixturePlayers:awayTeamFixturePlayers
                                    })
                                  })
                                  .catch(error => {
                                    console.log(error.toString());
                                    res.send("Sorry something went wrong sending your email - try sending it manually" + error);
                                  })
                                });   
                              })
                            })
                          })
                        })
                      })
                     })
                  })
                }
              })
            }
          })
        }
      })
    }
  }


  exports.fixture_rearrange_by_team_name = function(req, res,next){
    Fixture.rearrangeByTeamNames(req.body,function(err,result){
      if(err){
        next(err);
         console.log(err);
      }
      else{
 // console.log(result)
        res.send(result);
      }
    })
  }

  // GET /fixture-players/<filters...>
  //
  // Filters come from middleware/filterState.js, which parses them off the path in
  // the grammar the shared toolbar emits — the same source /player-stats and
  // /pair-stats read. This used to take them from req.params across six bespoke
  // route shapes in app.js, which only covered one filter at a time plus two fixed
  // pairs, so anything the toolbar actually built 404'd. Values arrive
  // percent-decoded, so 'Manchester%20Edgeley' matches the club name in the DB.
  exports.get_fixture_players_details = function(req, res) {

    var active = (res.locals.filterBar && res.locals.filterBar.active) || {};
    var searchObj = {
    }
    if (active.season){
      searchObj.season = active.season
    }
    if (active.team){
      searchObj.team = active.team
    }
    if (active.club){
      searchObj.club = active.club
    }
    Fixture.getMatchPlayerOrderDetails(searchObj,function(err,row){
      if (err){
        res.send(err);
      }
      else{
        let clubs = row.map(item => item.name).filter((value, index, self) => self.indexOf(value) === index) 
        let teams = row.map(item => item.teamName).filter((value, index, self) => self.indexOf(value) === index) 
        res.render('fixture-players', {
            static_path: '/static',
            title : "Fixture Player Details",
            pageDescription : "Find out who played which matches and in what order",
            filter:true,
            hideFilters:["division","gender","gametype"],
            teams:teams,
            clubs:clubs,
            result: row
        });
      }
    })
}

// GET /event/:id/:date-:homeTeam-:awayTeam
//
// getFixtureEventById can legitimately return zero rows, and this read row[0].homeTeam
// straight off the empty array — Sentry TAMESIDE-NODE-2, 308 events and still firing.
// Two different causes reach it:
//   - The fixture is gone. /event/5841/07102025-Aerospace A-GHAP A was most of those
//     events: id 5841 is inside the live range but the row has been deleted or
//     rearranged. header.ejs emits SportsEvent ld+json carrying these URLs, so Google
//     has them indexed and re-crawls long after the fixture disappears.
//   - The fixture is from an archived season, whose teams and clubs live in suffixed
//     snapshot tables that this query's INNER joins don't reach. 98 fixtures, all
//     2023-24. Those 404 for now rather than crashing; rendering them properly needs
//     the season-aware query described on the model.
exports.fixture_event_detail = function(req, res,next) {
  Fixture.getFixtureEventById(req.params.id, function(err,row){
    if (err){
      // Was res.send(err), which answered 200 with a serialised error object — a real
      // failure looked like a success to the browser and to monitoring.
      next(err);
    }
    else if (!row.length){
      return render404(req, res);
    }
    else{
      res.render('viewEventDetails', {
          static_path: '/static',
          title : 'Event Details: '+ row[0].homeTeam + " vs " + row[0].awayTeam,
          pageDescription : "View scorecard for this match",
          fixtureDetails: row[0],
          mapsApiKey:process.env.GMAPSAPIKEY,
          canonical: canonicalFor(req)
      });
    }
  })
};

exports.fixture_reminder_post = function(req,res,next){
  let toField = (req.body.email.indexOf(',') > 0 ? req.body.email.split(',') : [req.body.email])
  toField = toField.map(row => { return { "Email": row } } )
  console.log(toField)
  ejs.renderFile('views/emails/scorecardReminder.ejs', {}, {debug:true}, function(err, str){
    if (err) console.log("Error:" + err);
  msg = {
    "From": {
      "Email": "results@tameside-badminton.co.uk"
    },
    "ReplyTo": {
      "Email": "tameside.badders.results@gmail.com"
    },
    "To": toField,
    "Bcc": [
      {
        "Email": "tameside.badders.results@gmail.com"
      }
    ],
    "Subject": `Reminder: ${req.body.hometeam} vs ${req.body.awayteam}`,
    "TextPart": ` Just a timely reminder that the scorecard for your recent match is still outstanding, please enter it as soon as possible to help keep the website up to date
                  Thanks
                  Jonny`,
    "HTMLPart": str,
  }
const request = mailjet
  .post("send", {'version': 'v3.1'})
  .request({
  "Messages":[msg]})
  .then(() => {
    res.sendStatus(200)
  })
  .catch((err) => next(err))
})
}

exports.add_scorecard_photo = function(req,res,next){
  Fixture.updateScorecardPhoto(req.params.id, req.body.imgURL,function(err,row){
    if (err){
      res.send(err);
      // console.log(err);
    }
    else{
      msg = {
        "From": {
          "Email": "results@tameside-badminton.co.uk"
        },
        "ReplyTo": {
          "Email": "tameside.badders.results@gmail.com"
        },
        "To": [
          {
            "Email": "tameside.badders.results@gmail.com"
          }
        ],
        "Bcc": [
          {
            "Email": "tameside.badders.results@gmail.com"
          }
        ],
        "Subject": "scorecard updated",
        // Same reasoning as the "scorecard received" mail above: the photo goes as a
        // `secured` /scorecard-photo/:id link rather than the raw public S3 URL, which
        // stops working once the shared bucket's public ACLs are stripped.
        "TextPart": `a scorecard has been updated with a photo: https://tameside-badminton.co.uk/scorecard-photo/${req.params.id} check the result here: https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}`,
        "HTMLPart": `<p>a scorecard has been updated with a photo: <a href="https://tameside-badminton.co.uk/scorecard-photo/${req.params.id}">View the scorecard photo</a><br />Check the result here: <a href="https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}">Confirm</a> or <a href="https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}">https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}</a></p>`,
      }
    const request = mailjet
      .post("send", {'version': 'v3.1'})
      .request({
      "Messages":[msg]})
      .then(() => {
        res.sendStatus(200)
      })
    }
  })
}
/* ------------------------------------------------------------------ *
 * Inline fixture-date editing from the admin results grid.
 * Superadmin only. Edits the existing fixture's date in place — distinct
 * from the rearrangement flow, which archives the fixture and inserts a new
 * one.
 * ------------------------------------------------------------------ */
exports.admin_fixture_date_update = function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const date = (req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date — expected YYYY-MM-DD' });
  }
  // Store as a wall-clock string to avoid the TIMESTAMP -> JS Date off-by-one.
  Fixture.updateById({ date: date + ' 00:00:00' }, req.params.id, function (err, result) {
    if (err) return next(err);
    if (!result || !result.count) return res.status(404).json({ error: 'Fixture not found' });
    res.json({ ok: true, id: req.params.id, date: date });
  });
};

/* ------------------------------------------------------------------ *
 * GET /scorecard-photo/:id — the only way a scorecard photo is read
 * ------------------------------------------------------------------ */

// Required as a module rather than destructured so the tests can stub s3Client() —
// a destructured reference is bound at require time and cannot be replaced.
const s3util = require("../utils/s3");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const {
  photoKeyFromStored,
  contentTypeFor,
  downloadTypeFor,
  downloadNameFor,
} = require("../utils/scorecardPhoto");

// Scorecard photos were uploaded `ACL: public-read` and rendered straight out of the
// bucket, with the public URL stored in `scorecardstore."scoresheet-url"` and pasted into
// the notification email. So the authorization on a photo of a match was "know the URL",
// and the bucket is shared with the Stockport league site, which is now stripping those
// ACLs. Without this route every Tameside scorecard photo 403s when they do.
//
// THIS ROUTE IS KEYED BY ROW ID, NEVER BY OBJECT KEY. That is the whole design. There is
// deliberately no endpoint here that takes a key from the request: a proxy that streams
// any object in the bucket to anyone who knows a name has moved the problem rather than
// solved it, and the bucket holds another league's scorecards.
//
// Every part of the object's identity comes from the row: the draft must exist and must
// have a photo, and `photoKeyFromStored` accepts only an object under our own
// `tameside-` prefix — which is what stops the 817 inherited Stockport rows in this table
// (see utils/scorecardPhoto.js) resolving to another league's scorecard served from our
// origin.
//
// AUTHORIZATION IS `secured` — any logged-in user — and that is a deliberate match for
// the two places a photo is surfaced, rather than an oversight:
//
//   - the upload thank-you page, which the captain who just uploaded has to be able to
//     see, and
//   - the results-secretary email, read by a superadmin.
//
// Tameside has no per-draft link token (Stockport's HARD-03), so the alternative would be
// identifying the uploader. That is exactly the trap `player_auth_email` exists to
// document: a login address is very often not the contact address someone types into the
// form — only 34 of 101 role-holders matched on `playerEmail` alone — so matching on it
// would lock captains out of the photo they had just filed. Tightening this needs a token,
// which is its own change.
exports.scorecard_photo = function (req, res, next) {
  Fixture.getScorecardById(req.params.id, async (err, rows) => {
    if (err) return next(err);
    if (!rows || !rows.length) return res.status(404).end();

    const key = photoKeyFromStored(rows[0]["scoresheet-url"]);
    if (!key) return res.status(404).end();

    // An image is served inline; a PDF or Word document is a real scorecard too — 40 of
    // our 322 photos are PDFs — and is served as a download, because an inline PDF
    // renders in our origin and PDFs can carry script. Neither type is ever taken from
    // what S3 reports: see contentTypeFor.
    const contentType = contentTypeFor(key);
    const downloadType = contentType ? null : downloadTypeFor(key);
    if (!contentType && !downloadType) return res.status(404).end();

    let obj;
    try {
      obj = await s3util.s3Client().send(new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key,
      }));
    } catch (s3err) {
      // A key the bucket does not hold is a 404, not a 500, and not a Sentry event.
      // One row already points at a missing object (id 1767), and a photo that has gone
      // astray must not take the page with it.
      return res.status(404).end();
    }

    res.set("Content-Type", contentType || downloadType);
    // Belt and braces with the type rules above: the browser must not re-guess a type we
    // have deliberately narrowed.
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", contentType
      ? "inline"
      : 'attachment; filename="' + downloadNameFor(key) + '"');
    // `private` because a session is the authorization — a shared cache must not hold
    // the answer and hand it to the next person.
    res.set("Cache-Control", "private, max-age=300");
    if (obj.ContentLength) res.set("Content-Length", String(obj.ContentLength));

    // The stream needs its own 'error' listener. Without one, a failure part-way through
    // the transfer is an unhandled 'error' event on an EventEmitter, which takes the
    // whole instance down — the same shape as the unguarded model callbacks that were
    // killing the process from the filters work. Headers are already sent by then, so
    // all that is left is to stop talking.
    obj.Body.on("error", () => res.destroy());
    obj.Body.pipe(res);
  });
};
