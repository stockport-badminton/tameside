let Fixture = require("../models/fixture");
let Division = require("../models/division");
let Team = require("../models/teams");
let Player = require("../models/players");
let Game = require("../models/game");
let Auth = require("../models/auth");
var request = require("request");
const ejs = require('ejs');
const ICAL = require("ical.js");
const mailjet = require ('node-mailjet').apiConnect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET)

let SEASON = "";
if (new Date().getMonth() < 6) {
  SEASON = "" + new Date().getFullYear() - 1 + "" + new Date().getFullYear();
} else {
  SEASON = "" + new Date().getFullYear() + "" + (new Date().getFullYear() + 1);
}

const { body, validationResult } = require("express-validator");
const { sanitizeBody } = require("express-validator");

function greaterThan21(value, { req, path }) {
  var otherValue = path.replace("away", "home");
  if (value < 21 && req.body[otherValue] < 21) {
    return false;
  } else {
    return value;
  }
}

function differenceOfTwo(value, { req, path }) {
  var otherValue = path.replace("away", "home");
  if (Math.abs(value - req.body[otherValue]) < 2) {
    if (value < 30 && req.body[otherValue] < 30) {
      return false;
    } else {
      return value;
    }
  } else {
    return value;
  }
}

exports.validateScorecard = [
  body("Game1homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game1awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage("First Mens 1:winning score isn't 2 greater than losing score")
    .custom(greaterThan21)
    .withMessage("First Mens 1:one of the teams needs to score at least 21"),
  body("Game2homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game2awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage("First Mens 2:winning score isn't 2 greater than losing score")
    .custom(greaterThan21)
    .withMessage("First Mens 2:one of the teams needs to score at least 21"),
  body("Game3homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game3awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "First Ladies 1:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("First Ladies 1:one of the teams needs to score at least 21"),
  body("Game4homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game4awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "First Ladies 2:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("First Ladies 2:one of the teams needs to score at least 21"),
  body("Game5homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game5awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Second Mens 1:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Second Mens 1:one of the teams needs to score at least 21"),
  body("Game6homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game6awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Second Mens 2:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Second Mens 2:one of the teams needs to score at least 21"),
  body("Game7homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game7awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "First Mixed 1:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("First Mixed 1:one of the teams needs to score at least 21"),
  body("Game8homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game8awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "First Mixed 2:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("First Mixed 2:one of the teams needs to score at least 21"),
  body("Game9homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game9awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Second Mixed 1:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Second Mixed 1:one of the teams needs to score at least 21"),
  body("Game10homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game10awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Second Mixed 2:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Second Mixed 2:one of the teams needs to score at least 21"),
  body("Game11homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game11awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Third Mixed 1:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Third Mixed 1:one of the teams needs to score at least 21"),
  body("Game12homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game12awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Third Mixed 2:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Third Mixed 2:one of the teams needs to score at least 21"),
  body("Game13homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game13awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Fourth Mixed 1:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Fourth Mixed 1:one of the teams needs to score at least 21"),
  body("Game14homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game14awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Fourth Mixed 2:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Fourth Mixed 2:one of the teams needs to score at least 21"),
  body("Game15homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game15awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage("Third Mens 1:winning score isn't 2 greater than losing score")
    .custom(greaterThan21)
    .withMessage("Third Mens 1:one of the teams needs to score at least 21"),
  body("Game16homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game16awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage("Third Mens 2:winning score isn't 2 greater than losing score")
    .custom(greaterThan21)
    .withMessage("Third Mens 2:one of the teams needs to score at least 21"),
  body("Game17homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game17awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Fourth Mens 1:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Fourth Mens 1:one of the teams needs to score at least 21"),
  body("Game18homeScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30"),
  body("Game18awayScore")
    .isInt({ min: 0, max: 30 })
    .withMessage("must be between 0 and 30")
    .custom(differenceOfTwo)
    .withMessage(
      "Fourth Mens 2:winning score isn't 2 greater than losing score"
    )
    .custom(greaterThan21)
    .withMessage("Fourth Mens 2:one of the teams needs to score at least 21"),
  body("homeMan1", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.homeMan2 ||
          value == req.body.homeMan3 ||
          value == req.body.homeMan4 ||
          value == req.body.awayMan1 ||
          value == req.body.awayMan2 ||
          value == req.body.awayMan3 ||
          value == req.body.awayMan4
          ? false
          : value
        : value;
    })
    .withMessage("Home Man 1: can't use the same player more than once"),
  body("homeMan2", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.homeMan1 ||
          value == req.body.homeMan3 ||
          value == req.body.homeMan4 ||
          value == req.body.awayMan1 ||
          value == req.body.awayMan2 ||
          value == req.body.awayMan3 ||
          value == req.body.awayMan4
          ? false
          : value
        : value;
    })
    .withMessage("Home Man 2: can't use the same player more than once"),
  body("homeMan3", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.homeMan2 ||
          value == req.body.homeMan1 ||
          value == req.body.homeMan4 ||
          value == req.body.awayMan1 ||
          value == req.body.awayMan2 ||
          value == req.body.awayMan3 ||
          value == req.body.awayMan4
          ? false
          : value
        : value;
    })
    .withMessage("Home Man 3:can't use the same player more than once"),
  body("homeLady1", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.homeLady2 ||
          value == req.body.awayLady1 ||
          value == req.body.awayLady2
          ? false
          : value
        : value;
    })
    .withMessage("Home Lady 1: can't use the same player more than once"),
  body("homeLady2", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.homeLady1 ||
          value == req.body.awayLady1 ||
          value == req.body.awayLady2
          ? false
          : value
        : value;
    })
    .withMessage("Home Lady 2: can't use the same player more than once"),
  body("homeMan4", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.homeMan2 ||
          value == req.body.homeMan3 ||
          value == req.body.homeMan1 ||
          value == req.body.awayMan1 ||
          value == req.body.awayMan2 ||
          value == req.body.awayMan3 ||
          value == req.body.awayMan4
          ? false
          : value
        : value;
    })
    .withMessage("Home Man 4: can't use the same player more than once"),
  body("awayMan1", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.awayMan2 ||
          value == req.body.awayMan3 ||
          value == req.body.awayMan4 ||
          value == req.body.homeMan1 ||
          value == req.body.homeMan2 ||
          value == req.body.homeMan3 ||
          value == req.body.homeMan4
          ? false
          : value
        : value;
    })
    .withMessage("Away Man 1: can't use the same player more than once"),
  body("awayMan2", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.awayMan1 ||
          value == req.body.awayMan3 ||
          value == req.body.awayMan4 ||
          value == req.body.homeMan1 ||
          value == req.body.homeMan2 ||
          value == req.body.homeMan3 ||
          value == req.body.homeMan4
          ? false
          : value
        : value;
    })
    .withMessage("Away Man 2: can't use the same player more than once"),
  body("awayMan3", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.awayMan2 ||
          value == req.body.awayMan1 ||
          value == req.body.awayMan4 ||
          value == req.body.homeMan1 ||
          value == req.body.homeMan2 ||
          value == req.body.homeMan3 ||
          value == req.body.homeMan4
          ? false
          : value
        : value;
    })
    .withMessage("Away Man 3:can't use the same player more than once"),
  body("awayLady1", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.awayLady2 ||
          value == req.body.homeLady1 ||
          value == req.body.homeLady2
          ? false
          : value
        : value;
    })
    .withMessage("Away Lady 1: can't use the same player more than once"),
  body("awayLady2", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.awayLady1 ||
          value == req.body.homeLady1 ||
          value == req.body.homeLady2
          ? false
          : value
        : value;
    })
    .withMessage("Away Lady 2: can't use the same player more than once"),
  body("awayMan4", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.awayMan2 ||
          value == req.body.awayMan3 ||
          value == req.body.awayMan1 ||
          value == req.body.homeMan1 ||
          value == req.body.homeMan2 ||
          value == req.body.homeMan3 ||
          value == req.body.homeMan4
          ? false
          : value
        : value;
    })
    .withMessage("Away Man 4: can't use the same player more than once"),
  body("FirstMixedhomeMan1", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.SecondMixedhomeMan2 ||
          value == req.body.ThirdMixedhomeMan3 ||
          value == req.body.FourthMixedhomeMan4
          ? false
          : value
        : value;
    })
    .withMessage(
      "First Mixed Home Man: can't use the same player more than once"
    ),
  body("SecondMixedhomeMan2", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.FirstMixedhomeMan1 ||
          value == req.body.ThirdMixedhomeMan3 ||
          value == req.body.FourthMixedhomeMan4
          ? false
          : value
        : value;
    })
    .withMessage(
      "Second Mixed Home Man: can't use the same player more than once"
    ),
  body("ThirdMixedhomeMan3", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.FirstMixedhomeMan1 ||
          value == req.body.SecondMixedhomeMan2 ||
          value == req.body.FourthMixedhomeMan4
          ? false
          : value
        : value;
    })
    .withMessage(
      "Third Mixed Home Man: can't use the same player more than once"
    ),
  body("FourthMixedhomeMan4", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.FirstMixedhomeMan1 ||
          value == req.body.SecondMixedhomeMan2 ||
          value == req.body.ThirdMixedhomeMan3
          ? false
          : value
        : value;
    })
    .withMessage(
      "Third Mixed Home Man: can't use the same player more than once"
    ),
  body("FirstMixedawayMan1", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.SecondMixedawayMan2 ||
          value == req.body.ThirdMixedawayMan3 ||
          value == req.body.FourthMixedawayMan4
          ? false
          : value
        : value;
    })
    .withMessage(
      "First Mixed Away Man: can't use the same player more than once"
    ),
  body("SecondMixedawayMan2", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.FirstMixedawayMan1 ||
          value == req.body.ThirdMixedawayMan3 ||
          value == req.body.FourthMixedawayMan4
          ? false
          : value
        : value;
    })
    .withMessage(
      "Second Mixed Away Man: can't use the same player more than once"
    ),
  body("ThirdMixedawayMan3", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.FirstMixedawayMan1 ||
          value == req.body.SecondMixedawayMan2 ||
          value == req.body.FourthMixedawayMan4
          ? false
          : value
        : value;
    })
    .withMessage(
      "Third Mixed Away Man: can't use the same player more than once"
    ),
  body("FourthMixedawayMan4", "Please choose a player.")
    .isInt()
    .custom((value, { req }) => {
      return value != 0
        ? value == req.body.FirstMixedawayMan1 ||
          value == req.body.SecondMixedawayMan2 ||
          value == req.body.ThirdMixedawayMan3
          ? false
          : value
        : value;
    })
    .withMessage(
      "Third Mixed Away Man: can't use the same player more than once"
    ),
  body("FirstMixedhomeLady1", "Please choose a player.").isInt(),
  body("SecondMixedhomeLady2", "Please choose a player.").isInt(),
  body("ThirdMixedhomeLady1", "Please choose a player.").isInt(),
  body("FourthMixedhomeLady2", "Please choose a player.").isInt(),
  body("FirstMixedawayLady1", "Please choose a player.").isInt(),
  body("SecondMixedawayLady2", "Please choose a player.").isInt(),
  body("ThirdMixedawayLady1", "Please choose a player.").isInt(),
  body("FourthMixedawayLady2", "Please choose a player.").isInt(),
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
          var options = {
            'method': 'GET',
            'url': 'https://api.cloudinary.com/v1_1/hvunsveuh/resources/image/tags/messer2024?max_results=30&context=true',
            'headers': {
              'Authorization': 'Basic '+process.env.CLOUDINARY_AUTH
            }
          }
          //console.log(options);
          request(options,function(err,response,assets){
            //console.log(options);
            if (err){
              //console.log(err)
              return false
            }
            else{
              // console.log(JSON.parse(response.body).resources);
              res.render('homepage', {
                  static_path: '/static',
                  title : "Homepage",
                  pageDescription : "Clubs: Aerospace, College Green, Disley, GHAP, Hyde, Manchester Edgeley, Manor, Mellor, Medlock, Shell. Social and Competitive badminton in and around Tameside.",
                  result : recentResults,
                  row : upcomingFixtures,
                  scorecards:scorecards,
                  assets : JSON.parse(response.body).resources
              });
            }
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
          today.setHours(0);
          today.setMinutes(0);
          today.setSeconds(0);
          today.setMilliseconds(0);
          let nearestFixture = []
          while (nearestFixture.length == 0 && (today - new Date('2026-06-01')) < 0 ){
            today.setDate(today.getDate()+1)
            nearestFixture = result
            .map((row) => ({"date":row.date,"diff":new Date(row.date) - today}))
            .filter(row => (row.diff > -86400000))
          }
          if (nearestFixture.length == 0){
            nearestFixture.push(result[result.length-1])
          }
          console.log(`nearestFixture: ${nearestFixture[0].date}`)
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
            nearestDate:nearestFixture[0].date
          };
          if (req.path.search("admin") != -1) {
            if (
              req.user._json["https://my-app.example.com/role"] !== undefined
            ) {
              if (
                req.user._json["https://my-app.example.com/role"] == "admin"
              ) {
                renderObject.admin = true;
                renderObject.superadmin = false;
                renderObject.user = req.user;
              }
              if (
                req.user._json["https://my-app.example.com/role"] ==
                "superadmin"
              ) {
                renderObject.admin = true;
                renderObject.superadmin = true;
                renderObject.user = req.user;
              }
            }
          }
          console.log(renderObject)
          res.render("beta/fixtures-results" + type, renderObject);
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
    // console.log(req.session.user)
    if (req.path.search("admin") != -1) {
      if (req.user._json["https://my-app.example.com/role"] !== undefined) {
        if (req.user._json["https://my-app.example.com/role"] == "admin") {
          if (
            req.user._json["https://my-app.example.com/club"] != "All" &&
            req.user._json["https://my-app.example.com/club"] !== undefined
          ) {
            searchObj.club = req.user._json["https://my-app.example.com/club"];
          }
        }
      }
    }
 // console.log(searchObj);
    Fixture.getFixtureDetails(searchObj, function (err, result) {
      if (err) {
        next(err);
      } else {
        let today = new Date()
        today.setHours(0);
        today.setMinutes(0);
        today.setSeconds(0);
        today.setMilliseconds(0);
        let nearestFixture = []
        while (nearestFixture.length == 0 && (today - new Date('2026-06-01')) < 0 ){
          today.setDate(today.getDate()+1)
          nearestFixture = result
          .map((row) => ({"date":row.date,"diff":new Date(row.date) - today}))
          .filter(row => (row.diff > -86400000))

        }
        if (nearestFixture.length == 0){
          nearestFixture.push(result[result.length-1])
        }
        
        console.log(`nearestFixture: ${nearestFixture[0].date}`)
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
          nearestDate: nearestFixture[0].date
        };
        if (req.path.search("admin") != -1) {
          if (req.user._json["https://my-app.example.com/role"] !== undefined) {
            if (req.user._json["https://my-app.example.com/role"] == "admin") {
              renderObject.admin = true;
              renderObject.superadmin = false;
              renderObject.user = req.user;
            }
            if (
              req.user._json["https://my-app.example.com/role"] == "superadmin"
            ) {
              renderObject.admin = true;
              renderObject.superadmin = true;
              renderObject.user = req.user;
            }
          }
        }
        if (req.path.indexOf("fixtures") > -1) {
          res.status(200);
          res.send(result);
        }
        else{
          res.status(200);
        // console.log(result)
        console.log(renderObject)
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
        (searchObj.season != undefined ? searchObj.season : SEASON) +
        (searchObj.division != undefined ? searchObj.division : "") +
        (searchObj.club != undefined ? searchObj.club : "") +
        (searchObj.team != undefined ? searchObj.team : "");

      const jcal = new ICAL.Component("vcalendar");
      jcal.addPropertyWithValue(
        "prodid",
        (searchObj.season != undefined ? searchObj.season : SEASON) +
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
      next(err);
    } else {
      Auth.getManagementAPIKey(function (err, apiKey) {
        if (err) {
          next(err);
        } else {
          // console.log(req.session)
          var options = {
            method: "GET",
            headers: {
              Authorization: "Bearer " + apiKey,
            },
            url:
              "https://" +
              process.env.AUTH0_DOMAIN +
              "/api/v2/users?q=user_id:" +
              req.user.id +
              "&fields=app_metadata,nickname,email",
          };
          //console.log(options);
          request(options, function (err, response, userBody) {
            //console.log(options);
            if (err) {
              console.log(err)
              return false;
            } else {
              var user = JSON.parse(userBody);
              Fixture.getMissingScorecardPhotos(user[0].email, function (err, fixtures) {
                if (err) {
                  next(err);
                } else {
                  
                  console.log(user)
                  res.render("email-scorecard", {
                    static_path: "/static",
                    theme: process.env.THEME || "flatly",
                    title: "Scorecard",
                    pageDescription: "Enter some results!",
                    result: rows,
                    fixtures:fixtures
                  })
                };
              })
            }
          });
        }
      });
    }
  })
};

let msg = {}

exports.fixture_populate_scorecard_errors = function (req, res, next) {
  var errors = validationResult(req);
  // console.log(errors.array());
  if (!errors.isEmpty()) {
    let data = req.body;
    console.log(data);
    Division.getAllAndSelectedById(
      1,
      data.division,
      function (err, divisionRows) {
        if (err) {
          next(err);
        } else {
          // console.log(divisionIdRows)
          Team.getAllAndSelectedById(
            data.homeTeam,
            data.division,
            function (err, homeTeamRows) {
              if (err) {
                next(err);
              } else {
                // console.log(homeTeamRows)
                Team.getAllAndSelectedById(
                  data.awayTeam,
                  data.division,
                  function (err, awayTeamRows) {
                    if (err) {
                      next(err);
                    } else {
                      // console.log(awayTeamRows)
                      Player.getEligiblePlayersAndSelectedById(
                        data.homeMan1,
                        data.homeMan2,
                        data.homeTeam,
                        "Male",
                        function (err, homeMenRows) {
                          if (err) {
                            next(err);
                          } else {
                            // console.log(homeMenRows)
                            Player.getEligiblePlayersAndSelectedById(
                              data.homeLady1,
                              data.homeLady2,
                              data.homeTeam,
                              "Female",
                              function (err, homeLadiesRows) {
                                if (err) {
                                  next(err);
                                } else {
                                  // console.log(homeLadiesRows)
                                  Player.getEligiblePlayersAndSelectedById(
                                    data.awayMan1,
                                    data.awayMan2,
                                    data.awayTeam,
                                    "Male",
                                    function (err, awayMenRows) {
                                      if (err) {
                                        next(err);
                                      } else {
                                        // console.log(awayMenRows)
                                        Player.getEligiblePlayersAndSelectedById(
                                          data.awayLady1,
                                          data.awayLady2,
                                          data.awayTeam,
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
                                                homeLadiesRows: homeLadiesRows,
                                                awayMenRows: awayMenRows,
                                                awayLadiesRows: awayLadiesRows,
                                              };
 // console.log(renderData);
                                              res.render("email-scorecard", {
                                                static_path: "/static",
                                                title:
                                                  "Spreadsheet Upload Scorecard",
                                                pageDescription:
                                                  "Show result of uploading scorecard",
                                                scorecard: renderData,
                                                data: data,
                                                errors: errors.array(),
                                              });
                                            }
                                          }
                                        );
                                      }
                                    },
                                    data.awayMan3,
                                    data.awayMan4
                                  );
                                }
                              }
                            );
                          }
                        },
                        data.homeMan3,
                        data.homeMan4
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
  } else {
    let scorecardUrl =
      "https://" +
      req.headers.host +
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
      req.body.Game18awayScore;
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
    if (typeof scorecardObj["scoresheet-url"] == ''){
      scorecardObj["scoresheet-url"] = 'https://badmintontemp.s3.eu-west-1.amazonaws.com/tameside-'+req.body.homeTeam.replaceAll(' ','+')+'-'+req.body.awayTeam.replaceAll(' ','+')+'.jpg'
    }
    Fixture.createScorecard(scorecardObj, function (err, rows) {
      if (err) {
        console.log(err);
        next(err);
      } else {
 // console.log(rows);
        let scorecardUrlBeta =
          "https://" +
          req.headers.host +
          "/populated-scorecard-beta/" +
          rows[0].id;
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
                "Email": "bigcoops+tamesidewebsite@gmail.com"
              }
            ],
            "Subject": "scorecard received",
            "TextPart": `a new scorecard has been uploaded: ${req.body["scoresheet-url"]} check the result here: ${scorecardUrl}`,
            "HTMLPart": `<p>a new scorecard has been uploaded: <a href="${req.body["scoresheet-url"]}">${req.body["scoresheet-url"]}</a><br />Check the result here: <a href="${scorecardUrl}">Confirm</a> or <a href="${scorecardUrlBeta}">${scorecardUrlBeta}</a></p>`,
            
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
exports.getScorecard = function(req, res,next) {
  Fixture.getScorecardDataById(req.params.id, function(err,row){
    if (err){
      res.send(err);
      // console.log(err);
    }
    else{
      res.render('viewScorecard', {
          static_path: '/static',
          title : "Scorecard Info",
          pageDescription : "View scorecard for this match",
          result: row,
          canonical:("https://" + req.get("host") + req.originalUrl).replace("www.'","").replace(".com",".co.uk").replace("-badders.herokuapp","-badminton")
      });
    }
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
              for (game of gameObject.data){
                // console.log(`gameId: ${game.id}`)
                game.homePlayer1Start = prevScores[game.homePlayer1].rating
                game.homePlayer2Start = prevScores[game.homePlayer2].rating
                game.awayPlayer1Start = prevScores[game.awayPlayer1].rating
                game.awayPlayer2Start = prevScores[game.awayPlayer2].rating
                // console.log("FixtureID Rank: "+FixtureIdResult[0].rank)
                let fixtureRank = FixtureIdResult[0].rank
                await Game.calculateRating(game,prevScores,req.body.date,fixtureRank, async function(rateErr, rateResult){
                  // console.log(`rateResult: ${JSON.stringify(rateResult)}`)
                  if (rateErr){
                    console.error(`rateErr: ${JSON.stringify(rateErr)}`)
                  }
                  else if (rateResult && (game.homePlayer1 != 0 || game.homePlayer2 != 0 || game.awayPlayer1 != 0 || game.awayPlayer2 != 0 )){
                    prevScores[game.homePlayer1].rating = rateResult.updateObj.homePlayer1End
                    prevScores[game.homePlayer1].date = req.body.date
                    prevScores[game.homePlayer2].rating = rateResult.updateObj.homePlayer2End, 
                    prevScores[game.homePlayer2].date = req.body.date
                    prevScores[game.awayPlayer1].rating = rateResult.updateObj.awayPlayer1End, 
                    prevScores[game.awayPlayer1].date = req.body.date
                    prevScores[game.awayPlayer2].rating = rateResult.updateObj.awayPlayer2End, 
                    prevScores[game.awayPlayer2].date = req.body.date
                    game.homePlayer1End = rateResult.updateObj.homePlayer1End
                    game.homePlayer2End = rateResult.updateObj.homePlayer2End
                    game.awayPlayer1End = rateResult.updateObj.awayPlayer1End
                    game.awayPlayer2End = rateResult.updateObj.awayPlayer2End
                  }
                  else {
                    prevScores[game.homePlayer1].rating = rateResult.updateObj.homePlayer1End
                    prevScores[game.homePlayer1].date = req.body.date
                    prevScores[game.homePlayer2].rating = rateResult.updateObj.homePlayer2End, 
                    prevScores[game.homePlayer2].date = req.body.date
                    prevScores[game.awayPlayer1].rating = rateResult.updateObj.awayPlayer1End, 
                    prevScores[game.awayPlayer1].date = req.body.date
                    prevScores[game.awayPlayer2].rating = rateResult.updateObj.awayPlayer2End, 
                    prevScores[game.awayPlayer2].date = req.body.date
                    game.homePlayer1End = 1500
                    game.homePlayer2End = 1500
                    game.awayPlayer1End = 1500
                    game.awayPlayer2End = 1500
                  }
                })
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
                  Fixture.getFixtureDetailsById(FixtureIdResult[0].id,function(err,getFixtureDetailsResult){
                    if(err) res.send(err)
                    zapObject = {
                      "host":req.headers.host,
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
                                        "Email": "bigcoops+tamesidewebsite@gmail.com"
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

  exports.get_fixture_players_details = function(req, res) {

    var searchObj = {
    }
    if (req.params.season !== undefined){
      searchObj.season = req.params.season
    }
    if (req.params.team !== undefined){
      searchObj.team = req.params.team
    }
    if (req.params.club !== undefined){
      searchObj.club = req.params.club
    }
    Fixture.getMatchPlayerOrderDetails(searchObj,function(err,row){
      console.log(row)
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
            hideFilters:["season","division","gender","gametype"],
            teams:teams,
            clubs:clubs,
            result: row
        });
      }
    })
}

exports.fixture_event_detail = function(req, res,next) {
  Fixture.getFixtureEventById(req.params.id, function(err,row){
    if (err){
      res.send(err);
      // console.log(err);
    }
    else{
      res.render('viewEventDetails', {
          static_path: '/static',
          title : 'Event Details: '+ row[0].homeTeam + " vs " + row[0].awayTeam,
          pageDescription : "View scorecard for this match",
          fixtureDetails: row[0],
          mapsApiKey:process.env.GMAPSAPIKEY,
          canonical:("https://" + req.get("host") + req.originalUrl).replace("www.'","").replace(".com",".co.uk").replace("-badders.herokuapp","-badminton")
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
        "Email": "bigcoops+tamesidewebsite@gmail.com"
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
            "Email": "bigcoops+tamesidewebsite@gmail.com"
          }
        ],
        "Subject": "scorecard updated",
        "TextPart": `a scorecard has been updated with a photo: ${req.body.imgURL} check the result here: https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}`,
        "HTMLPart": `<p>a scorecard has been updated with a photo: <a href="${req.body.imgURL}">${req.body.imgURL}}</a><br />Check the result here: <a href="https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}">Confirm</a> or <a href="https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}">https://tameside-badminton.co.uk/populated-scorecard-beta/${req.params.id}</a></p>`,
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