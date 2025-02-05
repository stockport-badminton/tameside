let postgres = require('postgres')
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false } })

// POST
exports.create = async function(name,address,gMapUrl,done){
  let result = await sql`INSERT INTO venue (name,address,gMapUrl) VALUES (?,?,?)`.catch(err => {
        return done(err)
    })
    done(null,result.insertId);

  }

exports.createBatch = async function(BatchObj,done){
    if(db.isObject(BatchObj)){
      let bulkobj = BatchObj.data.map(row => {
        // Use reduce() to create an object for each row
        return row.reduce((obj, value, index) => {
            obj[BatchObj.fields[index]] = value; // Assign value to corresponding key
            return obj;
        }, {});
      })
      
      let rows = sql`insert into ${BatchObj.tablename} ${ sql(bulkobj) }`.catch(err => {
        return done(err)
      })
      done(null,rows);
    }
    else{
      return done('not object');
    }
  }

// GET
exports.getAll = async function(done){
  let result = await sql`SELECT * FROM venue`.catch(err => {
        return done(err)
    })
    done(null,result.insertId);

  }

exports.getVenueClubs = async function(done){
  let result = await sql`select
  "venueName",
  "Lat",
  "Lng",
  string_agg("venueClubsHTML", '<br />') as "venueInfoBox"
from
  (
    select
      "venueName",
      "Lat",
      "Lng",
      concat(
        '<strong id="firstHeading" class="firstHeading"><a href="',
        "clubWebsite",
        '">',
        "clubName",
        '</a></strong><div id="bodyContent"><p>Match Night:',
        "matchNightText",
        '<br />Club Night:',
        "clubNightText",
        '<br />Address:<a href="',
        "gMapUrl",
        '">',
        address,
        '</a></p></div>'
      ) as "venueClubsHTML"
    from
      (
        select
          venue."name" as "venueName",
          venue."address",
          venue."gMapUrl",
          venue."Lat",
          venue."Lng",
          club."name" as "clubName",
          club."matchNightText",
          club."clubNightText",
          club."clubWebsite"
        from
          venue
          join club
        on
          venue."id" = club."venue"
        union
        select
          venue."name" as "venueName",
          venue."address",
          venue."gMapUrl",
          venue."Lat",
          venue."Lng",
          club."name" as "clubName",
          club."matchNightText",
          club."clubNightText",
          club."clubWebsite"
        from
          venue
          join club
        on
          venue."id" = club."matchVenue"
      ) as "venueInfo"
  ) as "groupedVenueInfo"
group by
  "venueName",
  "Lat",
  "Lng"`.catch(err => {
        return done(err)
    })
    done(null,result);

  }

// GET
exports.getById = async function(venueId,done){
  let result = await sql`SELECT * FROM venue WHERE id = ?`.catch(err => {
        return done(err)
    })
    done(null,result.insertId);

  }

// DELETE
exports.deleteById = async function(venueId,done){
  let result = await sql`DELETE FROM venue WHERE id = ?`.catch(err => {
        return done(err)
    })
    done(null,result.insertId);

  }

// PATCH
exports.updateById = async function(name,address,gMapUrl, venueId,done){
  let result = await sql`UPDATE venue SET name = ?, address = ?, gMapUrl = ? WHERE id = ?`.catch(err => {
        return done(err)
    })
    done(null,result.insertId);

  }
