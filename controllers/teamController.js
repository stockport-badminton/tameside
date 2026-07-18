require('dotenv').config()
const contentful = require('contentful')
let { BLOCKS } = require('@contentful/rich-text-types') 
let { documentToHtmlString } = require('@contentful/rich-text-html-renderer');
let Team = require('../models/teams');
let Club = require('../models/club');
let Division = require('../models/division');
let Venue = require('../models/venue');

const client = contentful.createClient({
  space: process.env.CONTENTFUL_SPACE,
  environment: 'master', // defaults to 'master' if not set
  accessToken: process.env.CONTENTFUL_KEY
})



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
/* ------------------------------------------------------------------ *
 * Superadmin team admin UI: list (grouped by division), add/edit, and
 * one-click promotion / relegation between adjacent divisions.
 * Secured route + role check here.
 * ------------------------------------------------------------------ */

const promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

function isSuperAdmin(req) {
  return !!(req.user && req.user._json && req.user._json['https://my-app.example.com/role'] === 'superadmin');
}

const getAllTeamsP    = promisify(Team.getAll);
const getTeamByIdP    = promisify(Team.getById);
const adminCreateTeamP = promisify(Team.adminCreate);
const adminUpdateTeamP = promisify(Team.adminUpdate);
const setTeamDivisionP = promisify(Team.setDivision);
const getAllClubsP    = promisify(Club.getAll);
const getAllDivisionsP = promisify(Division.getAll);
const getDivisionByIdP = promisify(Division.getById);
const getAllVenuesP   = promisify(Venue.getAll);

function adminRenderOpts(title, extra) {
  return Object.assign({ static_path: '/static', title, pageDescription: title }, extra);
}

// Only these columns are accepted from the team form (whitelist). NOT NULL
// columns (name, venue, club, division, rank) are only included when non-empty
// so an update never nulls a required column; the form marks them required.
function teamFieldsFromBody(body) {
  const obj = {};
  if (body.name)     obj.name = body.name;
  if (body.venue)    obj.venue = body.venue;
  if (body.club)     obj.club = body.club;
  if (body.division) obj.division = body.division;
  if (body.rank !== undefined && body.rank !== '') obj.rank = body.rank;
  if (body.matchDay !== undefined) obj.matchDay = body.matchDay || null;
  return obj;
}

exports.admin_team_list = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [teams, divisions, clubs] = await Promise.all([
      getAllTeamsP(), getAllDivisionsP(), getAllClubsP()
    ]);
    const clubName = {};
    clubs.forEach(c => { clubName[c.id] = c.name; });
    // Group teams by division, ordered by division rank (unassigned last).
    const sortedDivs = divisions.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
    // NB: division.id is a bigint (returned as a string by postgres.js) while
    // team.division is an int (returned as a number) — compare as strings.
    const groups = sortedDivs.map(d => ({
      division: d,
      teams: teams
        .filter(t => String(t.division) === String(d.id))
        .map(t => ({ ...t, clubName: clubName[t.club] || '' }))
        .sort((a, b) => (a.divRank || 0) - (b.divRank || 0) || String(a.name).localeCompare(String(b.name)))
    }));
    const unassigned = teams.filter(t => !divisions.some(d => String(d.id) === String(t.division)))
      .map(t => ({ ...t, clubName: clubName[t.club] || '' }));
    res.render('admin/team-list', adminRenderOpts('Team Admin', { groups, unassigned }));
  } catch (err) { next(err); }
};

exports.admin_team_createForm = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [clubs, divisions, venues] = await Promise.all([getAllClubsP(), getAllDivisionsP(), getAllVenuesP()]);
    res.render('admin/team-form', adminRenderOpts('Add Team', { team: null, clubs, divisions, venues }));
  } catch (err) { next(err); }
};

exports.admin_team_create = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    await adminCreateTeamP(teamFieldsFromBody(req.body));
    res.redirect('/admin/teams');
  } catch (err) { next(err); }
};

exports.admin_team_editForm = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [rows, clubs, divisions, venues] = await Promise.all([
      getTeamByIdP(req.params.id), getAllClubsP(), getAllDivisionsP(), getAllVenuesP()
    ]);
    const team = rows && rows[0];
    if (!team) return res.status(404).send('Team not found');
    res.render('admin/team-form', adminRenderOpts('Edit Team', { team, clubs, divisions, venues }));
  } catch (err) { next(err); }
};

exports.admin_team_update = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    await adminUpdateTeamP(teamFieldsFromBody(req.body), req.params.id);
    res.redirect('/admin/teams');
  } catch (err) { next(err); }
};

// Promote (dir=up) or relegate (dir=down): move the team to the division in the
// same league whose rank is adjacent to its current division's rank.
exports.admin_team_move = async function(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const dir = req.body.dir === 'up' ? 'up' : 'down';
    const teamRows = await getTeamByIdP(req.params.id);
    const team = teamRows && teamRows[0];
    if (!team || team.division == null) return res.redirect('/admin/teams');

    const curDivRows = await getDivisionByIdP(team.division);
    const curDiv = curDivRows && curDivRows[0];
    if (!curDiv) return res.redirect('/admin/teams');

    const divisions = await getAllDivisionsP();
    const sameLeague = divisions
      .filter(d => d.league === curDiv.league)
      .sort((a, b) => (a.rank || 0) - (b.rank || 0));
    const idx = sameLeague.findIndex(d => d.id === curDiv.id);
    // up = promote = lower rank number = previous entry; down = next entry.
    const target = dir === 'up' ? sameLeague[idx - 1] : sameLeague[idx + 1];
    if (target) {
      await setTeamDivisionP(req.params.id, target.id);
    }
    res.redirect('/admin/teams');
  } catch (err) { next(err); }
};

/* ------------------------------------------------------------------ *
 * Superadmin Lewis Shield result entry + winner auto-progression.
 * Enter a result for a bracket match; the winner is written into its
 * next-round slot automatically (no full scorecards needed).
 * ------------------------------------------------------------------ */

const getLewisBracketP = promisify(Team.getLewisBracket);
const getLewisMetaP    = promisify(Team.getLewisMeta);
const saveLewisResultP = (drawPos, hs, as, pc, jv) =>
  new Promise((resolve, reject) => Team.saveLewisResult(drawPos, hs, as, pc, jv,
    (err, r) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(r)));

const LEWIS_ROUND_LABELS = ['Preliminary Round', 'Round 1', 'Quarter-Finals', 'Semi-Finals', 'Final'];

// Group bracket rows into rounds by drawPos, given the prelim count.
function lewisRounds(bracket, prelimCount) {
  const P = prelimCount;
  const bands = [
    { label: LEWIS_ROUND_LABELS[0], lo: 1,      hi: P },
    { label: LEWIS_ROUND_LABELS[1], lo: P + 1,  hi: P + 8 },
    { label: LEWIS_ROUND_LABELS[2], lo: P + 9,  hi: P + 12 },
    { label: LEWIS_ROUND_LABELS[3], lo: P + 13, hi: P + 14 },
    { label: LEWIS_ROUND_LABELS[4], lo: P + 15, hi: P + 15 },
  ];
  return bands
    .map(b => ({ label: b.label, matches: bracket.filter(m => Number(m.drawPos) >= b.lo && Number(m.drawPos) <= b.hi) }))
    .filter(b => b.matches.length);
}

exports.admin_lewis_form = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [bracket, meta, teams] = await Promise.all([getLewisBracketP(), getLewisMetaP(), getAllTeamsP()]);
    const teamName = { 52: 'TBD' };
    teams.forEach(t => { teamName[t.id] = t.name; });
    const rounds = lewisRounds(bracket, meta.prelimCount).map(round => ({
      label: round.label,
      matches: round.matches.map(m => ({
        drawPos: Number(m.drawPos),
        homeTeam: m.homeTeam, awayTeam: m.awayTeam,
        homeName: teamName[m.homeTeam] || ('#' + m.homeTeam),
        awayName: teamName[m.awayTeam] || ('#' + m.awayTeam),
        homeScore: m.homeScore, awayScore: m.awayScore,
        // Playable once both teams are known (not the 52 placeholder).
        playable: Number(m.homeTeam) !== 52 && Number(m.awayTeam) !== 52,
        played: m.homeScore != null || m.awayScore != null
      }))
    }));
    res.render('admin/lewis-results', adminRenderOpts('Lewis Shield Results', {
      rounds: rounds,
      notice: req.query.msg || null,
      error: req.query.err || null
    }));
  } catch (err) { next(err); }
};

exports.admin_lewis_result = async function (req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const meta = await getLewisMetaP();
    const result = await saveLewisResultP(
      req.params.drawPos, req.body.homeScore, req.body.awayScore, meta.prelimCount, meta.jValues
    );
    let msg = 'Result saved';
    if (result.advance && result.advance.advanced) {
      msg += `; winner advanced to slot ${result.advance.targetDrawPos} (${result.advance.side})`;
    } else if (result.advance && result.advance.reason === 'target-already-played') {
      msg += '; next round already has a result, winner NOT advanced';
    }
    res.redirect('/admin/lewis?msg=' + encodeURIComponent(msg));
  } catch (err) {
    res.redirect('/admin/lewis?err=' + encodeURIComponent(err.message || 'Could not save result'));
  }
};
