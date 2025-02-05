const { Batch } = require('aws-sdk');
let postgres = require('postgres')
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false },connect_timeout:120, idle_timeout:120 })
var Player = require('../models/players');
const { getAPIKey } = require('./auth');


let  SEASON = '';
 if (new Date().getMonth() < 6){
   SEASON = '' + new Date().getFullYear()-1 +''+ new Date().getFullYear();
 }
 else {
   SEASON = '' + new Date().getFullYear() +''+ (new Date().getFullYear()+1);
 }

// POST
exports.create = function(gameObj,done){
  if (db.isObject(gameObj)){
    var sql = 'INSERT INTO `game` (';
    var updateArray = [];
    var updateArrayVars = [];
    var updateArrayValues = []
    for (x in gameObj){
      // console.log(gameObj[x]);
      updateArray.push('`'+ x +'`');
      updateArrayVars.push(gameObj[x]);
      updateArrayValues.push('?');
    }
    var updateVars = updateArray.join(',');
    var updateValues = updateArrayValues.join(',');
    // console.log(updateVars);
    sql = sql + updateVars + ') VALUES (' + updateValues + ')';
    // console.log(sql);
    db.get().query(sql,updateArrayVars,function(err,result){
      if (err) return done(err);
      done(null,result);
    });
  }
  else {
    return done(err);
  }
}

exports.createBatch = async function(BatchObj,done){
    if(typeof BatchObj.fields !== undefined){
      // console.log(BatchObj)
      /* let bulkobj = BatchObj.data.map(row => {
        // Use reduce() to create an object for each row
        console.log(row)
        return row.reduce((obj, value, index) => {
            obj[BatchObj.fields[index]] = value; // Assign value to corresponding key
            return obj;
        }, {});
      }) */
      
      let rows = sql`insert into ${sql(BatchObj.tablename)} ${ sql(BatchObj.data) }`.catch(err => {
        return done(err)
      })
      console.log(rows)
      done(null,rows);
    }
    else{
      return done('not object');
    }
  }

// GET
exports.getAll = async function(done){
    let rows = await sql`SELECT * FROM "game"`.catch(err => {
          return done(err)
      })
      done(null,rows);
    }

// GET
exports.getById = async function(gameId,done){
    let rows = await sql`SELECT * FROM "game" WHERE "id" = ${gameId}`.catch(err => {
          return done(err)
      })
      done(null,rows);
    }

exports.getByFixture = async function(fixtureId,done){
  let rows = await sql`SELECT * FROM "game" WHERE "fixture" = ${fixtureId} order by id asc`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

// DELETE
exports.getById = async function(gameId,done){
    let rows = await sql`DELETE FROM "game" WHERE "id" = ${gameId}`.catch(err => {
          return done(err)
      })
      done(null,rows);
    }

// PATCH
exports.updateById = async function(gameObj,gameId,done){
  /* console.log(Object.values(gameObj))
  console.log(Object.keys(gameObj))
  console.log(gameId) */
    if (typeof gameObj !== 'undefined' && typeof gameId !== 'undefined'){
      let rows = await sql`
        update game set ${
          sql(gameObj, Object.keys(gameObj))
        }
        where id = ${ gameId }
      `.catch(err => {
        console.log(Object.values(gameObj))
        console.log(Object.keys(gameObj))
        console.log(`${gameId} : ${JSON.stringify(gameObj)}`)
        console.log(JSON.stringify(err))
        // console.log(err.query)
        return done(err)
      })
      // console.log(rows)
      // console.log(rows.statement.query)
      return done(null,rows);
    }
    else {
      console.error(`no gameobj or id: ${JSON.stringify(gameObj)}, ${gameId}`)
      return done(err);
    }
  
  }

  exports.calculateRating = async function(game,fixturePlayers,endDate,division,done){
    
        // console.log(homePlayer1Start)
        console.log(`calculate Rating game: ${JSON.stringify(game)}`)
        console.log(`calculate Rating fixturePlauers: ${JSON.stringify(fixturePlayers)}`)
        console.log(`calculate Rating division: ${division}`)
        let updateObj = {}
        let prevRatingDates = {}
        if (game.homePlayer1 == 0 || game.homePlayer2 == 0 || game.awayPlayer1 == 0 || game.awayPlayer2 == 0 ){

          updateObj = {
            "homePlayer1Start":(typeof fixturePlayers[game.homePlayer1] !== 'undefined' ? fixturePlayers[game.homePlayer1].rating : 1500),
            "homePlayer2Start":(typeof fixturePlayers[game.homePlayer2] !== 'undefined' ? fixturePlayers[game.homePlayer2].rating : 1500),
            "awayPlayer1Start":(typeof fixturePlayers[game.awayPlayer1] !== 'undefined' ? fixturePlayers[game.awayPlayer1].rating : 1500),
            "awayPlayer2Start":(typeof fixturePlayers[game.awayPlayer2] !== 'undefined' ? fixturePlayers[game.awayPlayer2].rating : 1500),
            "homePlayer1End":(typeof fixturePlayers[game.homePlayer1] !== 'undefined' ? fixturePlayers[game.homePlayer1].rating : 1500),
            "homePlayer2End":(typeof fixturePlayers[game.homePlayer2] !== 'undefined' ? fixturePlayers[game.homePlayer2].rating : 1500),
            "awayPlayer1End":(typeof fixturePlayers[game.awayPlayer1] !== 'undefined' ? fixturePlayers[game.awayPlayer1].rating : 1500),
            "awayPlayer2End":(typeof fixturePlayers[game.awayPlayer2] !== 'undefined' ? fixturePlayers[game.awayPlayer2].rating : 1500)
          }
          prevRatingDates = {
            "homePlayer1Start":(typeof fixturePlayers[game.homePlayer1] !== 'undefined' ? fixturePlayers[game.homePlayer1].date : "2020-01-01T00:00:00.000Z"),
            "homePlayer2Start":(typeof fixturePlayers[game.homePlayer2] !== 'undefined' ? fixturePlayers[game.homePlayer2].date : "2020-01-01T00:00:00.000Z"),
            "awayPlayer1Start":(typeof fixturePlayers[game.awayPlayer1] !== 'undefined' ? fixturePlayers[game.awayPlayer1].date : "2020-01-01T00:00:00.000Z"),
            "awayPlayer2Start":(typeof fixturePlayers[game.awayPlayer2] !== 'undefined' ? fixturePlayers[game.awayPlayer1].date : "2020-01-01T00:00:00.000Z"),
          }

        }
        else {
          let homePairStart = ((1*fixturePlayers[game.homePlayer1].rating + ((1*fixturePlayers[game.awayPlayer1].division - division)*500)) + (1*fixturePlayers[game.homePlayer2].rating + ((1*fixturePlayers[game.awayPlayer2].division - division)*500)))/2
          let awayPairStart = ((1*fixturePlayers[game.awayPlayer1].rating + ((1*fixturePlayers[game.homePlayer1].division - division)*500)) + (1*fixturePlayers[game.awayPlayer2].rating + ((1*fixturePlayers[game.homePlayer2].division - division)*500)))/2
          let awayAdjustment = 0
          let homeAdjustment = 0
          let homeExpectOutcome = 1 / (1 + Math.pow(10,((awayPairStart - homePairStart)/400)))
          let awayExpectOutcome = 1 / (1 + Math.pow(10,((homePairStart - awayPairStart)/400)))
          if (1*game.homeScore > 1*game.awayScore){
            homeAdjustment = Math.round(32 * (1 - homeExpectOutcome))
            awayAdjustment = Math.round(32 * (0 - awayExpectOutcome))
            console.log(`home win: ${ homeAdjustment } : ${awayAdjustment} : ${game.homeScore} - ${game.awayScore}`)
          }
          else {
            homeAdjustment = Math.round(32 * (0 - homeExpectOutcome))
            awayAdjustment = Math.round(32 * (1 - awayExpectOutcome))
            console.log(`away win: ${ homeAdjustment } : ${awayAdjustment} : ${game.homeScore} - ${game.awayScore}`)
          }

          let homePlayer1End = 1*fixturePlayers[game.homePlayer1].rating + 1*homeAdjustment
          let homePlayer2End = 1*fixturePlayers[game.homePlayer2].rating + 1*homeAdjustment
          let awayPlayer1End = 1*fixturePlayers[game.awayPlayer1].rating + 1*awayAdjustment
          let awayPlayer2End = 1*fixturePlayers[game.awayPlayer2].rating + 1*awayAdjustment
          updateObj = {
            "homePlayer1Start":fixturePlayers[game.homePlayer1].rating,
            "homePlayer2Start":fixturePlayers[game.homePlayer2].rating,
            "awayPlayer1Start":fixturePlayers[game.awayPlayer1].rating,
            "awayPlayer2Start":fixturePlayers[game.awayPlayer2].rating,
            "homePlayer1End":homePlayer1End,
            "homePlayer2End":homePlayer2End,
            "awayPlayer1End":awayPlayer1End,
            "awayPlayer2End":awayPlayer2End,
          }
          prevRatingDates = {
            "homePlayer1Start":fixturePlayers[game.homePlayer1].date,
            "homePlayer2Start":fixturePlayers[game.homePlayer2].date,
            "awayPlayer1Start":fixturePlayers[game.awayPlayer1].date,
            "awayPlayer2Start":fixturePlayers[game.awayPlayer2].date,
          }
        }  
        // console.log(`${JSON.stringify(updateObj)}`)
        done(null,{updateObj,prevRatingDates})
      }
