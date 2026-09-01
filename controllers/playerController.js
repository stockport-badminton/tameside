var Club = require('../models/club');
var Player = require('../models/players');
var Team = require('../models/teams');
var Fixture = require('../models/fixture');
var Game = require('../models/game');
var Division = require('../models/division');
var seasonModel = require('../models/season');
var async = require('async');
var jp = require('jsonpath');
const {distance, closest} = require('fastest-levenshtein');
const authz = require('../utils/authz');
const { validationResult } = require('express-validator');
const docx = require("docx");
const fs = require("fs")


// Display list of all Players
exports.player_list = function(req, res) {
    Player.search(req.params,function(err,rows){
      // console.log(rows);
      res.send(rows);
    })
};

// Display list of all Players
exports.player_played_up_counts = function(req, res) {
    Player.getPlayedUpCounts(function(err,rows){
      if (err) return next(err)
      res.render('played-up-counts', {
           static_path: '/static',
           theme: process.env.THEME || 'flatly',
           flask_debug: process.env.FLASK_DEBUG || 'false',
           title : "Played Up Counts",
           pageDescription : "Played Up Counts",
           result : rows
       });
    })
};




// Display list of all Players
exports.player_game_data = function(req, res,next) {
    Player.getPlayerGameData(req.params.id,function(err,rows){
      if (err) return next(err)
      res.render('player-game-stats', {
           static_path: '/static',
           theme: process.env.THEME || 'flatly',
           flask_debug: process.env.FLASK_DEBUG || 'false',
           title : "Player Game Data:"+ req.params.fullName,
           pageDescription : "Information about games that "+ req.params.fullName + "played in this season",
           result : rows,
           fullName: req.params.fullName
       });
    })
};


// Display list of all Players
exports.player_list_clubs_teams = function(req, res) {
    Player.getNamesClubsTeams(req.params, function(err,rows){
      // console.log(rows);
      if (err){
        // console.log("all_player_stats controller error")
        return next(err)
      }
      else {
        // console.log("all_player_stats controller success")
        // console.log(result);
        res.render('player-list', {
             static_path: '/static',
             theme: process.env.THEME || 'flatly',
             flask_debug: process.env.FLASK_DEBUG || 'false',
             title : "Player Registrations",
             pageDescription : "List of players registered to teams in the Stockport League",
             result : rows
         });
      }
    })
};

exports.find_closest_matched_player = function(req, res,next) {
// console.log("received request")
  var searchTerms = {
    "name":req.params.name,
    "gender":req.params.gender
  }
  Player.getNamesClubsTeams(searchTerms, function(err,rows){
    if (err){
      // console.log("all_player_stats controller error")
      return next(err)
    }
    else {
      // console.log(rows);
      var names = jp.query(rows,"$..name")
      var playerID = jp.query(rows,"$..playerId")
      var clubId = jp.query(rows,"$..clubId")
      var clubName = jp.query(rows,"$..clubName")
      //console.log(names);
      var distanceArray = [];
      var nameDistance = []
      for (const [i,name] of names.entries()) {
        distanceArray.push(distance(req.params.name,name))
        //console.log(name + ": " +distance(req.params.name,name))
        var nameDistanceElement = {
          "name":name,
          "distance":distance(req.params.name,name),
          "playerID":playerID[i],
          "clubId":clubId[i],
          "clubName":clubName[i]
        }
        if (nameDistanceElement.distance <= 10){
          nameDistance.push(nameDistanceElement);
        }
      }
      nameDistance.sort((a, b) => a.distance - b.distance);
      // console.log(nameDistance)
      res.send(nameDistance.slice(0,8))
    }
  })
}


exports.manage_player_list_clubs_teams = function(req, res,next) {
  // This used to fetch app_metadata from the Auth0 Management API on every request —
  // two HTTP round-trips (token, then user) for data already sitting on req.user from
  // login. Authorization now comes from the player table via the Auth0Strategy verify
  // callback in app.js, so the claims on req.user *are* the source of truth and the
  // round-trip is pure latency. The DEV_MODE fallback that used to live here went with
  // it: it existed only because the mock user has no Auth0 record to fetch.
  //
  // The promise wrapper is deliberately kept for its .catch(next). The body below
  // builds a .docx and writes it synchronously, and a throw in there has to become a
  // 500 for this request rather than an unhandled rejection.
  Promise.resolve().then(function(){
          const superadmin = authz.isSuperAdmin(req);
          // 'All' for a superadmin, a club name for an admin, false for neither —
          // passed to the view as-is, which is what it rendered before.
          const club = authz.userClub(req) || false;

          if (authz.hasClubAccess(req, req.params.club)){
            Player.getNamesClubsTeams(req.params, function(err,rows){
              // console.log(rows);
              if (err){
                // console.log("all_player_stats controller error")
                return next(err)
              }
              else if (rows.length < 1){
                const notFound = new Error("No club named " + req.params.club);
                notFound.status = 404;
                return next(notFound);
              }
              else {
                
                var manageTeamObject = {}
                manageTeamObject.teams = [];
                var teamNames = jp.query(rows,"$..teamName").filter((v,i,a)=>a.indexOf(v)==i)
                var teamIds = jp.query(rows,"$..teamId").filter((v,i,a)=>a.indexOf(v)==i)
                const table = new docx.Table({
                  rows:[
                    new docx.TableRow({
                      children: [
                          new docx.TableCell({
                              children: [new docx.Paragraph({
                                text: teamNames[0].substring(0,teamNames[0].length-2) + " Registrations",
                                style:"docHeading"
                            })],
                              columnSpan:4
                          })
                      ]
                  })
                  ],
                  margins: {
                    top: docx.convertInchesToTwip(0.05),
                    bottom: docx.convertInchesToTwip(0.05),
                    right: docx.convertInchesToTwip(0.1),
                    left: docx.convertInchesToTwip(0.1),
                  },
                  width:{
                    size:100,
                    type:docx.percentage
                  }});
                // console.log(teamNames);
                for(let i=0; i < teamNames.length; i++) {
                  table.addChildElement(new docx.TableRow({
                    children: [
                        new docx.TableCell({
                            children: [new docx.Paragraph({
                              text: teamNames[i],
                              style:"teamHeading"
                          })],
                            columnSpan:4
                        })
                    ],
                  }))
                  table.addChildElement(new docx.TableRow({
                    children: [
                        new docx.TableCell({
                            children: [new docx.Paragraph({
                              text: "Men",
                              style:"gender"
                          })],
                            columnSpan:2
                        }),
                        new docx.TableCell({
                            children: [new docx.Paragraph({
                              text: "Ladies",
                              style:"gender"
                          })],
                            columnSpan:2
                        }),
                    ],
                  }))
                
                  var nomMen = jp.query(rows,"$..[?(@.teamName=='"+teamNames[i]+"' && @.rank != 99 && @.gender == 'Male')]")
                  var nomLadies = jp.query(rows,"$..[?(@.teamName=='"+teamNames[i]+"' && @.rank != 99 && @.gender == 'Female')]")
                  var resMen = jp.query(rows,"$..[?(@.teamName=='"+teamNames[i]+"' && @.rank == 99 && @.gender == 'Male')]")
                  var resLadies = jp.query(rows,"$..[?(@.teamName=='"+teamNames[i]+"' && @.rank == 99 && @.gender == 'Female')]")
                  let longest = Math.max(nomMen.length + resMen.length,nomLadies.length + resLadies.length);
                  // console.log(nomMen.length + ": " + resMen.length + ": " + nomLadies.length + ": " + resLadies.length + ": " + longest)
                  for(let j=1; j <= longest; j++){
                    var manName = (j > (nomMen.length + resMen.length) ? "" : (j > nomMen.length ? resMen[j - nomMen.length-1].name : nomMen[j-1].name))
                    var menTeamName = teamNames[i].substring(teamNames[i].length - 1)
                    var ladiesTeamName = menTeamName
                    if (j > nomMen.length){
                      menTeamName = "R"
                    }
                    if (j > nomLadies.length){
                      ladiesTeamName = "R"
                    }
                    var ladyName = (j > (nomLadies.length + resLadies.length) ? "" : (j > nomLadies.length ? resLadies[j - nomLadies.length - 1].name : nomLadies[j-1].name))
                    table.addChildElement(new docx.TableRow({
                      children: [
                          new docx.TableCell({
                              children: [new docx.Paragraph(manName)],
                              width:{
                                size:40,
                                type:docx.PERCENTAGE
                              }
                          }),
                          new docx.TableCell({
                              children: [new docx.Paragraph(menTeamName)],
                              width:{
                                size:10,
                                type:docx.PERCENTAGE
                              }
                          }),
                          new docx.TableCell({
                              children: [new docx.Paragraph(ladyName)],
                              width:{
                                size:40,
                                type:docx.PERCENTAGE
                              }
                          }),
                          new docx.TableCell({
                              children: [new docx.Paragraph(ladiesTeamName)],
                              width:{
                                size:10,
                                type:docx.PERCENTAGE
                              }
                          }),
                      ],
                  }))
                  }

                  var teamObject = {
                    name:teamNames[i],
                    id:teamIds[i],
                    nominated:{
                      men:nomMen,
                      ladies:nomLadies
                    },
                    reserves:{
                      men:resMen,
                      ladies:resLadies
                    }
                  }

                  manageTeamObject.teams.push(teamObject);
  
                }
                const doc = new docx.Document({
                  title: "Title",
                  sections: [
                      {
                          children: [table],
                      },
                  ],
                  styles:{
                    paragraphStyles:[{
                      name:'Normal',
                      run:{
                        font:"Arial"
                      }
                    },
                    {
                      name:'docHeading',
                      basedOn:"Normal",
                      run:{
                        bold:true,
                        size:30
                      }
                    },
                    {
                      name:'teamHeading',
                      basedOn:"Normal",
                      run:{
                        bold:true,
                        size:24
                      }
                    },
                    {
                      name:'gender',
                      basedOn:"Normal",
                      run:{
                        bold:true
                      }
                    }]
                  }
                });
                
                docx.Packer.toBuffer(doc).then((buffer) => {
                    fs.writeFileSync('static/docs/'+teamNames[0].substring(0,teamNames[0].length-2)+'.docx', buffer);
                });
                // console.log(JSON.stringify(manageTeamObject));
                Club.getAll( function(err,clubsRes){
                  console.log(clubsRes);
                  if (err){
                    // console.log("all_player_stats controller error")
                    return next(err)
                  }
                  else {
                    let clubs = clubsRes.map(row => row.name)
                    res.render('team-admin', {
                        static_path: '/static',
                        theme: process.env.THEME || 'flatly',
                        flask_debug: process.env.FLASK_DEBUG || 'false',
                        title : "Player Registrations",
                        pageDescription : "List of players registered to teams in the Stockport League",
                        result : manageTeamObject,
                        clubId: rows[0].clubId,
                        superadmin:superadmin,
                        filter:true,
                        hideFilters:["season","gametype","gender","division"],
                        club:club,
                        clubs:clubs,
                        
                    });
                  }
              })
            }
          })
        }
          else {
            // A 403, not a fault. As a bare string this rendered the 500 page and
            // reported to Sentry — the authorization check working as designed.
            const denied = new Error("Sorry you don't have access to this page");
            denied.status = 403;
            return next(denied);
          }
  })
  .catch(next); // a throw/rejection here must not take down the process
};
// Return list of players eligible based on team
exports.eligible_players_list = function(req, res) {
    Player.findElgiblePlayersFromTeamId(req.params.id,req.params.gender,function(err,rows){
      res.send(rows);
    })
};

// Display detail page for a specific Player
exports.player_detail = function(req, res) {
  Player.getById(req.params.id,function(err,rows){
    // console.log(rows);
    res.send(rows);
  })
};

exports.all_player_stats = function (req, res,next){
  // console.log(Object.entries(req.params))
  const pattern = /(\bPremier(?!\s|-\d)|Division(?:-|\s))(\d+)/g;
  const replacedMatches = [];
  let divisionString = "All"
  let searchObj = {}
  // console.log(req.params)
  if (Object.entries(req.params).length > 0) {
    var convertedParams = req.params[0].replace('Premier','division-7')
    .replace('Division 1','division-8')
    .replace('Division-1','division-8')
    .replace('Division 2','division-9')
    .replace('Division-2','division-9')
    .replace('Division 3','division-10')
    .replace('Division-3','division-10')
    .replace('season-','')
    .replace(/(\/)(20\d\d20\d\d)/g,'$1season-$2')
    .replace(/(20\d\d20\d\d)/g,'season-$1')
  
    // Finding matches using regex and replacing them
    
    const replacedString = req.params[0].replace(pattern, (match, p1, p2) => {
      let replacedMatch;
      if (p1 === "Premier") {
        replacedMatch = p1;
      } else {
        replacedMatch = `${p1.replace('-', ' ')}${p2}`;
      }
      replacedMatches.push(replacedMatch);
      return replacedMatch;
    });
    var searchArray = convertedParams.split('/')
    searchObj = searchArray.reduce((acc, str) => {
      const [key, value] = str.split("-");
      return { ...acc, [key]: value };
    }, {});
    
// console.log(searchObj)
  }
  else {
    searchObj = {}
  }
  
  if (replacedMatches.length > 0){
    divisionString = replacedMatches[0]
  }
  
    // A club admin only sees their own club here; superadmins and no-role users see
    // everything. Read off req.user rather than the session copy — same object after
    // deserialize, and it drops a per-request log line that printed the whole
    // identity into Cloud Run.
    authz.scopeToAdminClub(req, searchObj);

  // console.log(regexParams)
  console.log(searchObj)
  Player.newGetPlayerStats(searchObj,function(err,result){
    if (err){
      return next(err)
    }
    else {
      // console.log(result)
      let clubs = result.map(item => item.clubName).filter((value, index, self) => self.indexOf(value) === index) 
      let teams = result.map(item => item.teamName).filter((value, index, self) => self.indexOf(value) === index) 
// console.log(req.params);
      res.render('player-stats', {
           static_path: '/static',
           theme: process.env.THEME || 'flatly',
           flask_debug: process.env.FLASK_DEBUG || 'false',
           title : "Player Stats",
           pageDescription : "Geek out on Stockport League Player stats!",
           filter : true,
           hideFilters:["status"],
           result : result,
           clubs : clubs,
           teams : teams,
           query:searchObj
       });
    }
  })
}


exports.all_pair_stats = function (req, res,next){
  // console.log(Object.entries(req.params))
  const replacedMatches = [];
  const pattern = /(\bPremier(?!\s|-\d)|Division(?:-|\s))(\d+)/g;
  let searchObj = {}
  //console.log(req.params)
  if (Object.entries(req.params).length > 0) {
    var convertedParams = req.params[0].replace('Premier','division-7')
    .replace('Division 1','division-8')
    .replace('Division-1','division-8')
    .replace('Division 2','division-9')
    .replace('Division-2','division-9')
    .replace('Division 3','division-10')
    .replace('Division-3','division-10')
    .replace('season-','')
    // .replace(/(\/)(20\d\d20\d\d)/g,'$1season-$2')
    .replace(/(20\d\d20\d\d)/g,'season-$1')
    
    // Finding matches using regex and replacing them
    
    const replacedString = req.params[0].replace(pattern, (match, p1, p2) => {
      let replacedMatch;
      if (p1 === "Premier") {
        replacedMatch = p1;
      } else {
        replacedMatch = `${p1.replace('-', ' ')}${p2}`;
      }
      replacedMatches.push(replacedMatch);
      return replacedMatch;
    });
    // console.log(regexParams)
    var searchArray = convertedParams.split('/')
    // console.log(searchArray)
    searchObj = searchArray.reduce((acc, str) => {
      const [key, value] = str.split("-");
      return { ...acc, [key]: value };
    }, {});
    // console.log(searchObj)
    // console.log(req.session.user)
    // A club admin only sees their own club here; superadmins and no-role users see
    // everything. Read off req.user rather than the session copy — same object after
    // deserialize, and it drops a per-request log line that printed the whole
    // identity into Cloud Run.
    authz.scopeToAdminClub(req, searchObj);
    
  }
  else {
    searchObj = {}
  }
  let divisionString = "All"
  if (replacedMatches.length > 0){
    divisionString = replacedMatches[0]
  }



  
  // console.log(searchObj)
  Player.newGetPairStats(searchObj,function(err,result){
    if (err){
      return next(err)
    }
    else {
      let clubs = result.map(item => item.clubName).filter((value, index, self) => self.indexOf(value) === index) 
      let teams = result.map(item => item.teamName).filter((value, index, self) => self.indexOf(value) === index) 
      // console.log(result)
      // console.log("rendering this page")
      // console.log(JSON.stringify(req.params))
      res.render('pair-stats', {
           static_path: '/static',
           theme: process.env.THEME || 'flatly',
           flask_debug: process.env.FLASK_DEBUG || 'false',
           title : "Pair Stats",
           pageDescription : "Geek out on Stockport League Player stats!",
           filter:true,
           hideFilters:["status"],
           clubs:clubs,
           teams:teams,
           result : result,
           query: searchObj
       });
    }
  })
}

// Display Player create form on GET
exports.player_create_get = function(req, res, next) {
  async.parallel({
    clubs:function(callback){
      Club.getAll(callback);
    },
  }, function(err,results){
    if(err){return next(err)};
    // console.log(results);
    res.render('player_form', { title: 'Create Player', pageDescription: 'Create a Player', static_path:'/static', theme:'flatly',club_list:results.clubs });
  })

};

exports.player_create_from_team = function(req,res){
  Player.create(req.body.first_name, req.body.family_name, req.body.team, req.body.club, req.body.gender, function(err,row){
    if (err){
      res.send(err);
    }
    else {
// console.log(row.insertId)
      res.send(row)
    }
  })
}
/* retrospectively populating game ranking scores. 
* for each fixture (ordered by date)
* for each game of that fixture
* for home pair
  * find a previous score (for the current season) (if none assume 1500), write to game row for each player
* for away pair
  * find a previous score (for the current season) (if none asume 1500), write to game row for each player
* calculate adjustment for result
  * write the adjusted scored to the game row for each player  */ 

/*

To calculate the expected outcome, we use the following formula:
Expected outcome for Player 1 = 1 / (1 + 10^((Player2Rating - Player1Rating)/400))

Expected outcome for Player 2 = 1 / (1 + 10^((Player1Rating - Player2Rating)/400))


In this case:
Expected outcome for Player 1 = 1 / (1 + 10^((1600 - 1400)/400)) = 1 / (1 + 10^(200/400)) = 1 / (1 + 10^0.5) = 1 / (1 + 3.162) = 1 / 4.162 = 0.240

Expected outcome for Player 2 = 1 - 0.240 = 0.760

Let's say Player 1 wins the match. The actual outcome is 1 for Player 1 and 0 for Player 2.

To calculate the rating adjustment for each player, we use the following formula:
Rating adjustment = KFactor * (Actual outcome - Expected outcome)

For Player 1: Rating adjustment = 32 * (1 - 0.240) = 32 * 0.760 = 24.32

For Player 2: Rating adjustment = 32 * (0 - 0.760) = 32 * -0.760 = -24.32 
*/

// Promise wrappers for the callback-style model functions used by the backfill.
const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)))
const getFixtureDetailsP = promisify(Fixture.getFixtureDetails)
const getGamesByFixtureP = promisify(Game.getByFixture)
const updateGameByIdP = promisify(Game.updateById)
const updatePlayersBulkP = promisify(Player.updateBulk)

// Delegates to the shared, DB-driven season model (single source of truth).
function currentSeasonName() {
  return seasonModel.current()
}

// Guard against Fixture.getFixtureDetails silently substituting the current
// season when handed a name its checkSeason rejects — validate here and skip
// bad names explicitly instead.
// Delegates to models/season.js, which is the single source of truth — this used to be
// a second copy of the same regex and year arithmetic.
const isValidSeasonName = seasonModel.isValidName

// Shared helper: process all complete fixtures for one season and update game ELO.
// seasonParam is a season name string (e.g. '20242025') or undefined for current season.
// Returns { fixtures, gamesProcessed, gamesSkipped, knownRatings }.
// carryoverRatings: optional map of { playerId: { rating, date, rank, gamesCount } }
// seeded from a previous season's run so ratings carry across season boundaries
// without a DB round-trip. Lewis Shield fixtures are skipped — cup games don't
// count towards ELO and keep the End = 0 "unrated" sentinel.
async function recalcSeasonElo(seasonParam, carryoverRatings = {}) {
  await Game.resetSeasonElo(seasonParam)

  const searchObj = { status: 'complete' }
  if (seasonParam) searchObj.season = seasonParam

  const rows = await getFixtureDetailsP(searchObj)
  let gamesProcessed = 0
  let gamesSkipped = 0
  let lewisFixturesSkipped = 0

  // knownRatings accumulates every player's latest End rating across fixtures so we
  // never need to re-query the DB mid-season (which was resetting everyone to 1500).
  const knownRatings = { ...carryoverRatings }

  for (const fixture of rows) {
    if (fixture.lewis_round != null) { lewisFixturesSkipped++; continue }

    // Collect all player IDs for this fixture (0 = walkover slot, never tracked).
    let fixturePlayers = {}
    for (const key of ['homeMan1','homeMan2','homeMan3','homeMan4','homeLady1','homeLady2',
                        'awayMan1','awayMan2','awayMan3','awayMan4','awayLady1','awayLady2']) {
      const pid = fixture[key]
      if (pid != null && pid != 0) fixturePlayers[pid] = {}
    }

    let games = await getGamesByFixtureP(fixture.id)
    if (games.length > 18) {
      // A re-entered scorecard appends another 18 rows to the same fixture —
      // rate only the latest entry (getByFixture orders by id ASC). The older
      // duplicate rows keep the End = 0 sentinel from the reset.
      games = games.slice(-18)
    }
    for (const game of games) {
      for (const pid of [game.homePlayer1, game.homePlayer2, game.awayPlayer1, game.awayPlayer2]) {
        if (pid != null && pid != 0 && !(pid in fixturePlayers)) fixturePlayers[pid] = {}
      }
    }

    // For players already seen this (or a prior) season, carry their rating forward
    // directly — no DB query needed. Only query for genuinely new players.
    const newPlayers = []
    for (const pid of Object.keys(fixturePlayers)) {
      if (pid in knownRatings) {
        fixturePlayers[pid] = { ...knownRatings[pid] }
      } else {
        newPlayers.push(pid)
      }
    }
    if (newPlayers.length > 0) {
      // gamesCount isn't tracked in the DB — a player loaded here is treated as
      // starting fresh for provisional-K purposes. Full accuracy (a true
      // lifetime games-played count) requires running eloBackfillAll from the
      // start of records rather than a single isolated season recalc.
      const loaded = await Player.getPrevRatingBatch(fixture.date, newPlayers)
      for (const [pid, val] of Object.entries(loaded)) {
        fixturePlayers[pid] = { ...val }
        knownRatings[pid] = fixturePlayers[pid]
      }
    }

    for (const game of games) {
      const rateResult = Game.calculateRating(game, fixturePlayers, fixture.date, fixture.rank)
      if (rateResult && (game.homePlayer1 != 0 || game.homePlayer2 != 0 || game.awayPlayer1 != 0 || game.awayPlayer2 != 0)) {
        for (const [slot, endKey] of [
          [game.homePlayer1, 'homePlayer1End'],
          [game.homePlayer2, 'homePlayer2End'],
          [game.awayPlayer1, 'awayPlayer1End'],
          [game.awayPlayer2, 'awayPlayer2End'],
        ]) {
          if (slot != null && slot != 0 && fixturePlayers[slot]) {
            fixturePlayers[slot].rating = rateResult.updateObj[endKey]
            fixturePlayers[slot].date = fixture.date
            fixturePlayers[slot].gamesCount = (fixturePlayers[slot].gamesCount || 0) + 1
            knownRatings[slot] = { ...fixturePlayers[slot] }
          }
        }
        await updateGameByIdP(rateResult.updateObj, game.id)
        gamesProcessed++
      } else {
        gamesSkipped++
      }
    }

    // updateBulk mutates its inputs, so build fresh arrays per fixture.
    const playerUpdate = {
      tablename: 'player',
      data: Object.entries(fixturePlayers)
        .filter(([id]) => parseInt(id, 10) > 0)
        .map(([id, p]) => [parseInt(id, 10), p.rating]),
      fields: ['id', 'rating']
    }
    if (playerUpdate.data.length > 0) await updatePlayersBulkP(playerUpdate)
  }

  return { fixtures: rows.length, gamesProcessed, gamesSkipped, lewisFixturesSkipped, knownRatings }
}

function isEloAdmin(req) {
  return authz.isSuperAdmin(req) || (process.env.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production')
}

// GET /players/eloFullRecalc?season=20242025  (superadmin or DEV_MODE only)
// Zeros ELO for one season then reprocesses every complete fixture in date order.
// Omit ?season to target the current season.
exports.player_elo_full_recalc = async function(req, res, next) {
  if (!isEloAdmin(req)) return res.status(403).send('Forbidden')
  try {
    const seasonParam = req.query.season || undefined
    if (seasonParam && !isValidSeasonName(seasonParam)) {
      return res.status(400).send(`Invalid season name: ${seasonParam}`)
    }
    const result = await recalcSeasonElo(seasonParam)
    res.send(`Full recalc complete (season: ${seasonParam || 'current'}). Fixtures: ${result.fixtures}; games processed: ${result.gamesProcessed}; skipped: ${result.gamesSkipped}; Lewis fixtures skipped: ${result.lewisFixturesSkipped}`)
  } catch (err) {
    next(err)
  }
}

// GET /players/eloBackfillAll  (superadmin or DEV_MODE only)
// Reprocesses ALL seasons from oldest to newest so the ELO chain is consistent
// across season boundaries.  Ratings carry over: each season seeds from the
// previous season's final game ratings.
exports.player_elo_backfill_all = async function(req, res, next) {
  if (!isEloAdmin(req)) return res.status(403).send('Forbidden')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Transfer-Encoding', 'chunked')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    const allSeasons = await Fixture.getAllSeasons()
    const currentSeason = currentSeasonName()

    const flush = () => { if (typeof res.flush === 'function') res.flush() }

    res.write('Resetting all ELO values...\n'); flush()
    await Game.resetAllElo()
    res.write(`Done. Processing ${allSeasons.length} seasons:\n\n`); flush()

    const results = []
    let carryoverRatings = {}

    for (const s of allSeasons) {
      res.write(`  ${s.name}... `); flush()
      const isCurrentSeason = s.name === currentSeason
      if (!isCurrentSeason && !isValidSeasonName(s.name)) {
        res.write(`skipped (invalid season name)\n`); flush()
        continue
      }
      try {
        const seasonParam = isCurrentSeason ? undefined : s.name
        const r = await recalcSeasonElo(seasonParam, carryoverRatings)
        carryoverRatings = r.knownRatings
        results.push({ season: s.name, ...r })
        res.write(`${r.fixtures} fixtures, ${r.gamesProcessed} games processed, ${r.lewisFixturesSkipped} Lewis fixtures skipped\n`); flush()
      } catch (seasonErr) {
        res.write(`skipped (${seasonErr.message})\n`); flush()
      }
    }

    const totalFixtures = results.reduce((a, r) => a + r.fixtures, 0)
    const totalProcessed = results.reduce((a, r) => a + r.gamesProcessed, 0)
    const totalSkipped = results.reduce((a, r) => a + r.gamesSkipped, 0)

    res.write(`\nAll done. Total: ${totalFixtures} fixtures, ${totalProcessed} games processed, ${totalSkipped} skipped.`)
    res.end()
  } catch (err) {
    res.write(`\nERROR: ${err.message}`)
    res.end()
  }
}

// GET /api/seasons
// Returns the list of seasons from the database.
exports.get_seasons_api = async function(req, res, next) {
  try {
    const seasons = await Fixture.getAllSeasons()
    res.json(seasons)
  } catch (err) {
    next(err)
  }
}

// GET /players/eloBackfillAdmin  (secured)
// Admin page for triggering per-season or all-season ELO backfill.
exports.player_elo_backfill_admin = async function(req, res, next) {
  if (!isEloAdmin(req)) return res.status(403).send('Forbidden')
  try {
    const seasons = await Fixture.getAllSeasons()
    res.render('elo-backfill', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'ELO Backfill Admin',
      pageDescription: 'ELO rating backfill admin tool',
      seasons
    })
  } catch (err) {
    next(err)
  }
}

// GET /api/player-elo?players=1,2,3
// Returns ELO time-series JSON for use by the chart pages.
const ELO_CHART_MAX_PLAYERS = 20

exports.player_elo_history_api = async function(req, res, next) {
  try {
    const rawIds = (req.query.players || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n)).slice(0, ELO_CHART_MAX_PLAYERS)
    if (rawIds.length === 0) return res.json([])
    const data = await Player.getPlayerEloTimeSeries(rawIds)
    res.json(data)
  } catch (err) {
    next(err)
  }
}

// GET /api/players/search?q=Smith&division=Premier&club=Dome&team=Dome+A&gender=Male
// Returns player name/id matches for the comparison page search, optionally
// narrowed by the same division/club/team/gender filters used on /player-stats.
exports.player_search_api = async function(req, res, next) {
  try {
    const q = (req.query.q || '').trim()
    const filters = {
      division: (req.query.division || '').trim(),
      club: (req.query.club || '').trim(),
      team: (req.query.team || '').trim(),
      gender: (req.query.gender || '').trim(),
    }
    const hasFilter = Object.values(filters).some(v => v.length > 0)
    if (q.length < 2 && !hasFilter) return res.json([])
    const results = await Player.searchPlayers(q, filters)
    res.json(results)
  } catch (err) {
    next(err)
  }
}

// GET /elo-chart
// Renders the multi-player ELO comparison page.
exports.player_elo_chart = async function(req, res, next) {
  try {
    const rawIds = (req.query.players || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n)).slice(0, ELO_CHART_MAX_PLAYERS)
    const [seriesData, divisions, clubs, teams] = await Promise.all([
      rawIds.length > 0 ? Player.getPlayerEloTimeSeries(rawIds) : [],
      promisify(Division.getAll)(),
      promisify(Club.getAll)(),
      promisify(Team.getAll)(),
    ])
    res.render('elo-chart', {
      static_path: '/static',
      theme: process.env.THEME || 'flatly',
      title: 'ELO Chart',
      pageDescription: 'Compare player ELO ratings over time',
      seriesData: JSON.stringify(seriesData),
      selectedIds: rawIds.join(','),
      maxPlayers: ELO_CHART_MAX_PLAYERS,
      divisions,
      clubs,
      teams
    })
  } catch (err) {
    next(err)
  }
}

// GET /dev/elo-raw/:playerId  (DEV_MODE only)
// Shows raw Start/End ELO values from game records for a player across all seasons,
// in chronological order. Use this to diagnose whether the stored values are correct.
exports.player_elo_raw = async function(req, res, next) {
  if (process.env.DEV_MODE !== 'true' || process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found')
  }
  try {
    const playerId = parseInt(req.params.playerId, 10)
    const { sql } = require('../utils/db_connect')
    const rows = await sql`
      SELECT
        fixture.date,
        game.id AS "gameId",
        game.fixture AS "fixtureId",
        CASE
          WHEN game."homePlayer1" = ${playerId} THEN 'homePlayer1'
          WHEN game."homePlayer2" = ${playerId} THEN 'homePlayer2'
          WHEN game."awayPlayer1" = ${playerId} THEN 'awayPlayer1'
          WHEN game."awayPlayer2" = ${playerId} THEN 'awayPlayer2'
        END AS slot,
        CASE
          WHEN game."homePlayer1" = ${playerId} THEN game."homePlayer1Start"
          WHEN game."homePlayer2" = ${playerId} THEN game."homePlayer2Start"
          WHEN game."awayPlayer1" = ${playerId} THEN game."awayPlayer1Start"
          WHEN game."awayPlayer2" = ${playerId} THEN game."awayPlayer2Start"
        END AS "startVal",
        CASE
          WHEN game."homePlayer1" = ${playerId} THEN game."homePlayer1End"
          WHEN game."homePlayer2" = ${playerId} THEN game."homePlayer2End"
          WHEN game."awayPlayer1" = ${playerId} THEN game."awayPlayer1End"
          WHEN game."awayPlayer2" = ${playerId} THEN game."awayPlayer2End"
        END AS "endVal"
      FROM game
      JOIN fixture ON game.fixture = fixture.id
      WHERE game."homePlayer1" = ${playerId} OR game."homePlayer2" = ${playerId} OR game."awayPlayer1" = ${playerId} OR game."awayPlayer2" = ${playerId}
      ORDER BY fixture.date ASC, game.id ASC
    `

    // Flag places where startVal doesn't match previous game's endVal.
    // End = 0 rows are unrated (Lewis Shield) — they don't advance the chain.
    let prevEnd = null
    const annotated = rows.map(r => {
      const isRated = r.endVal !== null && parseInt(r.endVal) !== 0
      const gap = isRated && prevEnd !== null && r.startVal !== null && parseInt(r.startVal) !== prevEnd
        ? { expectedStart: prevEnd, diff: parseInt(r.startVal) - prevEnd }
        : null
      if (isRated) prevEnd = parseInt(r.endVal)
      return { ...r, gap }
    })

    res.json({ playerId, totalGames: rows.length, games: annotated })
  } catch (err) {
    next(err)
  }
}

// GET /dev/elo-audit  (DEV_MODE only)
// Scans all current-season games in date order and reports cases where a
// player's start rating doesn't match the end rating from their previous game.
exports.player_elo_audit = async function(req, res, next) {
  if (process.env.DEV_MODE !== 'true' || process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found')
  }
  try {
    const games = await Game.getSeasonGamesOrdered(req.query.season || undefined)

    // Track each player's most recently seen end rating
    const lastEnd = {}
    const discrepancies = []

    for (const g of games) {
      const positions = [
        { id: g.homePlayer1, start: g.homePlayer1Start, end: g.homePlayer1End },
        { id: g.homePlayer2, start: g.homePlayer2Start, end: g.homePlayer2End },
        { id: g.awayPlayer1, start: g.awayPlayer1Start, end: g.awayPlayer1End },
        { id: g.awayPlayer2, start: g.awayPlayer2Start, end: g.awayPlayer2End },
      ]
      for (const p of positions) {
        if (!p.id || p.id === 0) continue
        if (lastEnd[p.id] !== undefined && lastEnd[p.id] !== p.start) {
          discrepancies.push({
            playerId: p.id,
            gameId: g.id,
            fixtureId: g.fixtureId,
            date: g.date,
            expectedStart: lastEnd[p.id],
            actualStart: p.start,
            diff: p.start - lastEnd[p.id]
          })
        }
        lastEnd[p.id] = p.end
      }
    }

    res.json({
      gamesScanned: games.length,
      discrepanciesFound: discrepancies.length,
      discrepancies
    })
  } catch (err) {
    next(err)
  }
}

// Handle Player create on POST
exports.player_create = function(req,res){
  Player.create(req.body.first_name, req.body.family_name, req.body.team, req.body.club, req.body.gender, function(err,row){
    if (err){
      res.send(err);
    }
    else {
      // console.log(row);
      Player.getPlayerClubandTeamById(row.insertId,function(err,rows){
        if (err){
          res.send(err)
        }
        else{
          res.render('player_form', { title: 'Create Player', pageDescription: 'Create a Player', static_path:'/static', theme:'flatly',result:req.body, row:rows });
          // console.log(req.body);
          // console.log(rows);
        }
      })

    }
  })

}



// POST /player/batch-update — the team-admin drag-and-drop write path.
//
// This route had NO auth gate and NO validation, and it passed req.body straight into
// Player.updateBulk as `tablename` / `fields` / `data`. That is an unauthenticated
// "UPDATE any table SET any column WHERE id = any id" endpoint: identifiers are escaped
// by postgres.js so it was not SQL injection, which hardly helped — `player.role` was
// writable by anyone who could reach the URL.
//
// It is NOT redundant and cannot simply be removed: three views drive it
// (views/team-admin.ejs twice, views/AddCreatePlayerModal.ejs once), all of them
// reordering players within a club. So it is gated instead, to exactly what those
// callers need.
//
// Four checks, in order of what they cost:
//
//   1. `secured` on the route (app.js).
//   2. Shape. Every id and value must be a finite integer, and the batch is capped.
//      updateBulk splices its way through parallel arrays and would happily write
//      `undefined` into a column on a ragged payload.
//   3. An allowlist of one table and four columns. The three callers send
//      `player` with some subset of {id, team, rank, club}; nothing else has ever been
//      a legitimate use of this endpoint, and `role` / `statsAccess` must never be
//      reachable from it.
//   4. Club scope, resolved from the DATABASE rather than from the payload. A club admin
//      may only touch players in their own club, and an id that does not exist is a
//      refusal rather than a pass. This is checked for the whole batch BEFORE any write,
//      so a batch that is half in scope writes nothing.
//
// A club admin may also only move a player *to* their own club, which is why `club` is
// range-checked against the caller's own club id as well.
const BATCH_ALLOWED_TABLE = 'player';
const BATCH_ALLOWED_FIELDS = new Set(['id', 'team', 'rank', 'club']);
const BATCH_MAX_ROWS = 200;

function badBatchRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Parsed and validated payload, or an Error with .status set.
function parseBatchPayload(body) {
  if (!body || typeof body !== 'object') return badBatchRequest('Expected a JSON body');
  const { tablename, fields, data } = body;

  if (tablename !== BATCH_ALLOWED_TABLE) {
    return badBatchRequest(`This endpoint only updates the ${BATCH_ALLOWED_TABLE} table`);
  }
  if (!Array.isArray(fields) || !fields.length) return badBatchRequest('fields must be a non-empty array');
  if (!Array.isArray(data) || !data.length) return badBatchRequest('data must be a non-empty array');
  if (data.length > BATCH_MAX_ROWS) return badBatchRequest(`At most ${BATCH_MAX_ROWS} rows per batch`);

  const unknown = fields.filter(f => !BATCH_ALLOWED_FIELDS.has(f));
  if (unknown.length) return badBatchRequest(`Not updatable here: ${unknown.join(', ')}`);
  if (new Set(fields).size !== fields.length) return badBatchRequest('duplicate field names');

  const idIndex = fields.indexOf('id');
  if (idIndex < 0) return badBatchRequest('fields must include id');

  const ids = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length !== fields.length) {
      return badBatchRequest('every data row must have one value per field');
    }
    for (const value of row) {
      // Integers only. Every allowed column is a bigint, and this is what stops a
      // ragged or coerced payload writing nonsense.
      if (!Number.isInteger(value)) return badBatchRequest('every value must be an integer');
    }
    ids.push(row[idIndex]);
  }
  if (new Set(ids).size !== ids.length) return badBatchRequest('the same player appears twice');

  return { tablename, fields, data, ids, clubIndex: fields.indexOf('club') };
}

exports.player_batch_update = function(req, res, next){
  const parsed = parseBatchPayload(req.body);
  if (parsed instanceof Error) return next(parsed);

  const superadmin = authz.isSuperAdmin(req);
  if (!superadmin && !authz.isAdmin(req)) {
    const err = new Error("You don't have access to update players");
    err.status = 403;
    return next(err);
  }

  Player.getClubsForPlayerIds(parsed.ids, function (err, rows) {
    if (err) return next(err);

    // Every id must exist. A missing row is a refusal: without this, an id that is not
    // in the table has no club to compare and would fall through the scope check.
    const byId = new Map((rows || []).map(r => [Number(r.id), r]));
    const missing = parsed.ids.filter(id => !byId.has(id));
    if (missing.length) {
      const e = new Error(`Unknown player id: ${missing.join(', ')}`);
      e.status = 400;
      return next(e);
    }

    if (!superadmin) {
      const outOfScope = parsed.ids.filter(id => !authz.hasClubAccess(req, byId.get(id).clubName));
      if (outOfScope.length) {
        const e = new Error("Some of those players are not in your club");
        e.status = 403;
        return next(e);
      }
      // A club admin must not move a player INTO another club either. Their own club id
      // is whatever their existing players have; taken from the batch's own rows, which
      // have just been confirmed to be theirs.
      if (parsed.clubIndex >= 0) {
        const ownClubIds = new Set(parsed.ids.map(id => Number(byId.get(id).club)));
        const targets = parsed.data.map(row => row[parsed.clubIndex]);
        const foreign = targets.filter(c => !ownClubIds.has(Number(c)));
        if (foreign.length) {
          const e = new Error("You can't move a player into another club from here");
          e.status = 403;
          return next(e);
        }
      }
    }

    // updateBulk mutates the arrays it is given, so hand it a fresh copy — the
    // validated `parsed` is still needed for nothing after this, but the callers'
    // payload should not be the thing that gets spliced either.
    const patch = {
      tablename: parsed.tablename,
      fields: parsed.fields.slice(),
      data: parsed.data.map(row => row.slice()),
    };
    Player.updateBulk(patch, function(updateErr, result){
      if (updateErr) return next(updateErr);
      res.json(result);
    });
  });
}

// Display Player delete form on GET

// Handle Player delete on POST

// Who may edit this player row at all: a superadmin may edit anyone, a club admin
// only players in their own club. Nobody else — before this, the GET had no auth gate
// whatsoever and the POST had only `secured`, so any logged-in user could read and
// rewrite any player's decrypted contact details and club-role flags.
//
// Returns a 403-shaped Error rather than calling next() bare, so the central handler
// can tell "not allowed" from "not found".
function assertPlayerEditAccess(req, playerRow) {
  if (authz.isSuperAdmin(req)) return null;
  if (authz.isAdmin(req) && authz.hasClubAccess(req, playerRow.clubName)) return null;
  const err = new Error("You don't have access to edit this player");
  err.status = 403;
  return err;
}

// Display Player update form on GET
exports.player_update_get = function(req, res,next) {
  Player.getPlayerDetailsbyId(req.params.id,function(err,result){
    if (err){
      return next(err)
    }
    else if (!result || !result.length) {
      // Unknown player id — 404 rather than crashing the view on result[0].id.
      return next()
    }
    else {
      const denied = assertPlayerEditAccess(req, result[0]);
      if (denied) return next(denied);

      res.render('player_update_form', {
           static_path: '/static',
           title : "Pair Stats",
           pageDescription : "Geek out on Stockport League Player stats!",
           result : result,
           // Gates the Site Role / Stats Access controls in the view. The POST
           // re-derives this rather than trusting it back, so this only decides what
           // is rendered — it is not the security boundary.
           canEditRole : authz.isSuperAdmin(req),
           canonical:("https://" + req.get("host") + req.originalUrl).replace("www.'","").replace(".com",".co.uk").replace("-badders.herokuapp","-badminton")
       });
    }
  })
};

// Handle Player update on POST
//
// The row is loaded before anything is written, for two reasons: the club-scoped
// authorization check needs to know which club this player is in, and the site-role
// fields must only be honoured for a superadmin. `secured` alone used to be the whole
// check here, which meant any logged-in user could rewrite any player.
exports.player_update_post = function(req, res, next) {
  Player.getPlayerDetailsbyId(req.params.id, function(err, existing){
    if (err) return next(err);
    if (!existing || !existing.length) return next();

    const denied = assertPlayerEditAccess(req, existing[0]);
    if (denied) return next(denied);

    const patchObj = {
      "tablename":"player",
      // otherComms was missing from this list even though the column and the form
      // control both existed, so every save silently cleared it.
      "fields":[
          "id","first_name","family_name","gender","playerTel","playerEmail","teamCaptain","clubSecretary","matchSecrertary","treasurer","otherComms"
      ],
      "data":[[req.params.id,req.body.first_name,req.body.family_name,req.body.gender,req.body.playerTel,req.body.playerEmail, req.body.teamCaptain == 1 ? 1 :0, req.body.clubSecretary == 1 ? 1 :0, req.body.matchSecrertary == 1 ? 1 :0, req.body.treasurer == 1 ? 1 : 0, req.body.otherComms == 1 ? 1 : 0]
      ]
    }

    Player.updateBulk(patchObj, function(err,row){
      if (err) return next(err);

      // Site role and stats access are superadmin-only, and this is where that is
      // actually enforced: the view hides the controls for everyone else, but a club
      // admin can still POST the fields by hand, so they are read only after the
      // check rather than trusted because the form omitted them. A superadmin who
      // submits the form is authoritative — no role posted means no role.
      if (!authz.isSuperAdmin(req)) {
        return res.redirect(`/player/${req.params.id}/update`);
      }

      // Never touches authEmail: that link is what the login lookup matches on, and
      // this form knows nothing about it (see models/players.setAuthRole).
      Player.setAuthRole(req.params.id, {
        role: req.body.role || null,
        statsAccess: req.body.statsAccess == 1,
      }).then(function(){
        res.redirect(`/player/${req.params.id}/update`);
      }).catch(next);
    })
  })
};
