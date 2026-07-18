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

// Handle Club create on POST


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

/* ------------------------------------------------------------------ *
 * Superadmin club admin UI (secured route + role check here).
 * ------------------------------------------------------------------ */

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

function isSuperAdmin(req) {
  return !!(req.user && req.user._json && req.user._json['https://my-app.example.com/role'] === 'superadmin');
}

const getAllClubsP = promisify(Club.getAll);
const getClubByIdP = promisify(Club.getById);
const createClubP = promisify(Club.create);
const updateClubP = promisify(Club.updateById);
const getAllVenuesP = promisify(Venue.getAll);

function adminRenderOpts(title, extra) {
  return Object.assign({ static_path: '/static', title, pageDescription: title }, extra);
}

exports.admin_club_list = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const clubs = await getAllClubsP();
    res.render('admin/club-list', adminRenderOpts('Club Admin', { clubs }));
  } catch (err) { next(err); }
};

exports.admin_club_createForm = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const venues = await getAllVenuesP();
    res.render('admin/club-form', adminRenderOpts('Add Club', { club: null, venues }));
  } catch (err) { next(err); }
};

exports.admin_club_create = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    await createClubP(req.body.name, req.body.venue);
    res.redirect('/admin/clubs');
  } catch (err) { next(err); }
};

exports.admin_club_editForm = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [rows, venues] = await Promise.all([getClubByIdP(req.params.id), getAllVenuesP()]);
    const club = rows && rows[0];
    if (!club) return res.status(404).send('Club not found');
    res.render('admin/club-form', adminRenderOpts('Edit Club', { club, venues }));
  } catch (err) { next(err); }
};

exports.admin_club_update = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    await updateClubP(req.body.name, req.body.venue, req.params.id);
    res.redirect('/admin/clubs');
  } catch (err) { next(err); }
};
