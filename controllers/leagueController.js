
let League = require('../models/league.js');

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