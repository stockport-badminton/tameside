require('dotenv').config()
const contentful = require('contentful')
let { BLOCKS } = require('@contentful/rich-text-types') 
let { documentToHtmlString } = require('@contentful/rich-text-html-renderer');
let Team = require('../models/teams');

const client = contentful.createClient({
  space: process.env.CONTENTFUL_SPACE,
  environment: 'master', // defaults to 'master' if not set
  accessToken: process.env.CONTENTFUL_KEY
})

exports.teamFixtures = (req, res, next) => {
    let contentItem = ""
    switch (req.params.team){
      case "Hyde A":
        contentItem = "2MGjt27j2YDOCmproHPIhT"
        break;
      case "Hyde B":
        contentItem = "5PAAihSZxv7fxVNQSVzJLF"
        break;
      case "Hyde C":
        contentItem = "3BFebk0B2Hy4gP9YITzYsC"
        break;
      default:
        contentItem = "2MGjt27j2YDOCmproHPIhT"
    }
    client.getEntry(contentItem)
    .then((entry) => {
        // console.log(entry)
        const rawRichTextField = entry.fields.richTextField;
        return documentToHtmlString(rawRichTextField);
      })
      .then((renderedHtml) => {
        // console.log(renderedHtml)
        res.render('homepage',{
            pageHeading:req.params.team + " Fixtures",
            title:req.params.team + " Fixtures",
            entry:renderedHtml.replace("<table>","<table class=\"table-responsive table-bordered text-center\">"),
            static_path : "/static" 
        })
      }) 
    .catch(console.error) 
}


exports.team_list = function(req,res,next) {
  Team.getAll(function(err,rows){
    if(err){
      res.send(err);
      console.log(err);
    }
    else{
      // console.log(result)
      res.send(rows);
    }
  })
};

// Display list of all Teams
exports.team_search = function(req,res,next) {
  Team.getTeams(req.body,function(err,rows){
    if(err){
      res.send(err);
      console.log(err);
    }
    else{
      // console.log(result)
      res.send(rows);
    }
  })
};

// Display detail page for a specific Team
exports.team_detail = function(req, res) {
  Team.getById(req.params.id,function(err,row){
    // console.log(row);
    res.send(row);
  })
};

exports.lewis_draw = function(req, res,next) {
  let searchObj = {}
  if (req.params.season !== undefined){
    searchObj.season = req.params.season
  }
  Team.getLewis(searchObj,function(err,rows){
    if(err){
      next(err);
      console.log(err)
    }
    else{
      // console.log(rows)
      var otherArray = rows.reduce(function(obj,row){
        // console.log(row)
        obj[row.drawPos] = {"homeTeam":row.homeTeamName,"awayTeam":row.awayTeamName,"homeScore":row.homeScore,"awayScore":row.awayScore,"prelims":row.lewisPrelims}; 
        return obj;
      }, {});
      
      // console.log(otherArray);
      // var totalRounds = Math.ceil(Math.log(rows.length)/Math.log(2))
      //console.log(JSON.stringify(rows));
      res.render('lewis-shield', {
        static_path: '/static',
        theme: process.env.THEME || 'flatly',
        flask_debug: process.env.FLASK_DEBUG || 'false',
        teams: otherArray,
        title : "Lewis Shield Draw and results" ,
        pageDescription : "Lewis Shield Draw and results",
        canonical:("https://" + req.get("host") + req.originalUrl).replace("www.'","").replace(".com",".co.uk").replace("-badders.herokuapp","-badminton")
      });
    }
  })
}