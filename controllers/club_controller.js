var Club = require('../models/club');
var Venue = require('../models/venue');
var Team = require('../models/teams');
require('dotenv').config()


// Display list of all Clubs
exports.club_list = function(req, res) {
    Club.getAll(function(err,rows){
      //console.log(rows);
      res.send(rows);
    })
};

// Display list of all Clubs
exports.club_list_detail = function(req, res, next) {
  // console.log(req.session)
    Club.clubDetail(function(err,result){
      if(err){
        // console.log(result)
        res.status(500);
        next(err);
      }
      else{
        Venue.getVenueClubs(function(err,venueRows){
          if(err) {res.status(500); next(err);}
          else {
            let newClubArray = []
            let newClubElem = {}
            let prevRowElem = {}
            let teamElem = {}
            for (row of result){
              if (row.clubId == prevRowElem.id ){
                teamElem = {}
                teamElem.name = row.teamname
                teamElem.venue = row.teammatchvenue
                teamElem.gMapUrl = row.teamgmap
                teamElem.address = row.teamaddress
                teamElem.matchDay = row.matchDay
                if (prevRowElem.teams[prevRowElem.teams.length -1].matchDay != row.matchDay){
                  prevRowElem.teams.push(teamElem)
                }
              }
              else {
                newClubElem = {}
                newClubElem.id = row.clubId
                newClubElem.name = row.name
                newClubElem.venue = row.clubvenue
                newClubElem.gMapUrl = row.clubgmap
                newClubElem.address = row.clubaddress
                newClubElem.matchNightText = row.matchNightText
                newClubElem.clubNightText = row.clubNightText
                newClubElem.clubWebsite = row.clubWebsite
                newClubElem.teams = []
                teamElem = {}
                teamElem.name = row.teamname
                teamElem.venue = row.teammatchvenue
                teamElem.gMapUrl = row.teamgmap
                teamElem.address = row.teamaddress
                teamElem.matchDay = row.matchDay
                newClubElem.teams.push(teamElem)
                if (prevRowElem != {}){
                  newClubArray.push(prevRowElem)
                }
                prevRowElem = newClubElem
              }             
            }
            newClubArray.push(newClubElem)
            newClubArray.shift()
            //console.log(JSON.stringify(newClubArray))

            res.status(200);
            res.render('club', {
                 static_path: '/static',
                 title : "Local Badminton Club Information",
                 pageDescription : "Find your local badminton clubs, when they play, where they play.",
                 result: newClubArray,
                 error: false,
                 recaptcha : process.env.RECAPTCHA,
                 mapsApiKey: process.env.GMAPSAPIKEY,
                 venues:JSON.stringify(venueRows)
             });
          }

        })
        // console.log(result)

      }
    })
};

exports.club_detail_api = function(req, res,next) {
  Club.getContactDetailsById(req.params.id,function(err,clubrow){
    if(err || typeof clubrow == 'undefined' || clubrow.length == 0){
      console.log(err)
      res.status(500);
      next(err);
    }
    else{
      res.send(clubrow)
    }
  })
};

// Display detail page for a specific Club
exports.club_detail = function(req, res,next) {
  // console.log(req.session)
    Club.getContactDetailsById(req.params.id,function(err,clubrow){
      if(err || typeof clubrow == 'undefined' || clubrow.length == 0){
        console.log(err)
        res.status(500);
        next(err);
      }
      else{
        //console.log("clubrow");
        // console.log(clubrow);
        res.status(200);
        res.render('club-contact', {
            static_path: '/static',
            title : clubrow[0].clubName + " Contact information",
            pageDescription : clubrow[0].clubName + "'s Club / Team Contact information",
            clubrow: clubrow,
            error: false,
            mapsApiKey: process.env.GMAPSAPIKEY,
        });
      }
    })
};

// Display Club create form on GET
exports.club_create_get = function(req, res) {
    res.send('NOT IMPLEMENTED: Club create GET');
};

// Handle Club create on POST
exports.club_create_post = function(req, res) {
  Club.create(req.body.name, req.body.venue, function(err,row){
    //console.log(req.body);
    //console.log(row);
    res.send(row);
  })
};

exports.club_batch_create = function(req, res){
  Club.createBatch(req.body,function(err,result){
    if(err){
      res.send(err);
      //console.log(err);
    }
    else{
      // console.log(result)
      res.send(result);
    }
  })
}

// Display Club delete form on GET
exports.club_delete_get = function(req, res) {
    res.send('NOT IMPLEMENTED: Club delete GET');
};

// Handle Club delete on POST
exports.club_delete_post = function(req, res) {
    Club.deleteById(req.params.id,function(err,row){
      //console.log(req.params)
      //console.log(row);
      res.send(row);
    })
};

// Display Club update form on GET
exports.club_update_get = function(req, res) {
    res.send('NOT IMPLEMENTED: Club update GET');
};

// Handle Club update on POST
exports.club_update_post = function(req, res) {
    Club.updateById(req.body.name, req.body.venue, req.params.id, function(err,row){
      //console.log(req.body);
      //console.log(row);
      res.send(row);
    })
};
