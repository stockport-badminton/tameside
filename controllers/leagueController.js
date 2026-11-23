
let League = require('../models/league.js');
const seasonModel = require('../models/season');
const { runIn, GAMES_PER_FIXTURE } = require('../utils/leagueRunIn');

// Display list of all Leagues
exports.league_table = function(req,res,next) {

  
    League.getLeagueTable(req.params.division,req.params.season,function(err,result){
      if (err){
        console.log(err);
        next(err);
      }
      else{
          // console.log(result)
          res.status(200);
         res.render('tables', {
             static_path: '/static',
             theme: process.env.THEME || 'flatly',
             flask_debug: process.env.FLASK_DEBUG || 'false',
             title : "League Table: "+ req.params.division.replace('-',' '),
             pageDescription : "Find out how your teams are peforming this season",
             division : req.params.division.replace('-',' '),
             result : result,
             error : err,
             season:req.params.season
         });
      }
    })
};

exports.all_league_tables = function(req,res,next) {

    League.getAllLeagueTables(req.params.season,function(err,result){
      if (err){
        console.log(err);
        next(err);
      }
      else{

          // console.log(result)
          res.status(200);
         res.render('all-tables', {
             static_path: '/static',
             theme: process.env.THEME || 'flatly',
             flask_debug: process.env.FLASK_DEBUG || 'false',
             title : "League Tables",
             pageDescription : "Find out how your teams are peforming this season",
             result : result,
             season:req.params.season
         });
      }
    })
};
// The run-in (superadmin): this season's tables with the places going up and down marked,
// and which of those are already certain. See utils/leagueRunIn.js.
exports.run_in = async function(req, res, next) {
  try {
    const [rows, moving] = await Promise.all([League.getRunIn(), League.movingPlaces()]);
    res.render('admin/league-run-in', {
      static_path: '/static',
      title: 'League run-in',
      pageDescription: 'This season\'s run-in: who is going up and who is going down',
      divisions: runIn(rows, moving),
      moving,
      season: seasonModel.current(),
      GAMES_PER_FIXTURE,
    });
  } catch (err) {
    next(err);
  }
};
