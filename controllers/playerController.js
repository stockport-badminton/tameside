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
var Auth = require('../models/auth.js');
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
  Auth.getManagementAPIKey(function (err,apiKey){
    if (err){
      next(err);
    }
    else{
      fetch(`https://${process.env.AUTH0_DOMAIN}/api/v2/users?q=user_id:${req.user.id}&fields=app_metadata,nickname,email`, {
        method: 'GET',
        headers: { "Authorization": "Bearer " + apiKey }
      })
      .then(response => response.json())
      .then(function(user){
          if (user[0].app_metadata.role) {
            if (user[0].app_metadata.role == "superadmin"){
              var superadmin = true;
            }
            else {
              var superadmin = false;
            }
          }
          if (user[0].app_metadata.club) {
            var club = user[0].app_metadata.club;
          }
          else {
            var club = false;
          }
          if (user[0].app_metadata.club == req.params.club || user[0].app_metadata.club == "All"){
            Player.getNamesClubsTeams(req.params, function(err,rows){
              // console.log(rows);
              if (err){
                // console.log("all_player_stats controller error")
                return next(err)
              }
              else if (rows.length < 1){
                return next("no club by that name");
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
            return next("Sorry you don't have access to this page");
          }
      })
    }
  })
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
  
    if (typeof req.session.passport !== 'undefined'){
      console.log(`sesion: ${JSON.stringify(req.session.passport.user)}`)
      if (req.session.passport.user._json["https://my-app.example.com/role"] !== undefined){
        if (req.session.passport.user._json["https://my-app.example.com/role"] == "admin"){
          if (req.session.passport.user._json["https://my-app.example.com/club"] != "All" && req.session.passport.user._json["https://my-app.example.com/club"] !== undefined){
          searchObj.club = req.session.passport.user._json["https://my-app.example.com/club"]
          }
        }
      }
    }

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
    if (typeof req.session.passport !== 'undefined'){
      console.log(`sesion: ${JSON.stringify(req.session.passport.user)}`)
      if (req.session.passport.user._json["https://my-app.example.com/role"] !== undefined){
        if (req.session.passport.user._json["https://my-app.example.com/role"] == "admin"){
          if (req.session.passport.user._json["https://my-app.example.com/club"] != "All" && req.session.passport.user._json["https://my-app.example.com/club"] !== undefined){
          searchObj.club = req.session.passport.user._json["https://my-app.example.com/club"]
          }
        }
      }
    }
    
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
function isValidSeasonName(name) {
  if (!/^\d{8}$/.test(name)) return false
  const firstYear = parseInt(name.slice(0, 4), 10)
  const secondYear = parseInt(name.slice(4), 10)
  return secondYear - firstYear === 1 && firstYear >= 2012
}

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
  const isSuperAdmin = req.user && req.user._json &&
    req.user._json['https://my-app.example.com/role'] === 'superadmin'
  return isSuperAdmin || (process.env.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production')
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



exports.player_batch_update = function(req, res){
  Player.updateBulk(req.body,function(err,result){
    if(err){
      res.send(err);
 console.log(err);
    }
    else{
       // console.log(result)
      res.send(result);
    }
  })
}

// Display Player delete form on GET

// Handle Player delete on POST

// Display Player update form on GET
exports.player_update_get = function(req, res,next) {
  Player.getPlayerDetailsbyId(req.params.id,function(err,result){
    if (err){
      return next(err)
    }
    else {
      
      res.render('player_update_form', {
           static_path: '/static',
           title : "Pair Stats",
           pageDescription : "Geek out on Stockport League Player stats!",
           result : result,
           canonical:("https://" + req.get("host") + req.originalUrl).replace("www.'","").replace(".com",".co.uk").replace("-badders.herokuapp","-badminton")
       });
    }
  })
};

// Handle Player update on POST
// Handle Player update on POST
exports.player_update_post = function(req, res) {
  console.log("inside player_update_post")
  let patchObj = {
    "tablename":"player",
    "fields":[
        "id","first_name","family_name","gender","playerTel","playerEmail","teamCaptain","clubSecretary","matchSecrertary","treasurer"
    ],
    "data":[[req.params.id,req.body.first_name,req.body.family_name,req.body.gender,req.body.playerTel,req.body.playerEmail, req.body.teamCaptain == 1 ? 1 :0, req.body.clubSecretary == 1 ? 1 :0, req.body.matchSecrertary == 1 ? 1 :0, req.body.treasurer == 1 ? 1 : 0]
  ]
}
 console.log('patchObj')
 console.log(patchObj)
  Player.updateBulk(patchObj, function(err,row){
    if (err){
      res.send(err);
      console.log(err)
    }
    else {
      console.log("redirecting")
      res.redirect(`/player/${req.params.id}/update`);
    }
  })
};
