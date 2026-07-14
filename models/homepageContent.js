const { sql } = require('../utils/db_connect');

// Homepage announcements — the content-managed News feed on the homepage.
// All functions follow the repo's done(err, rows) callback convention, but use
// try/catch rather than the .catch(done) idiom so done is never called twice.

exports.getActive = async function(done){
  try {
    const rows = await sql`SELECT * FROM homepage_announcement WHERE active = true ORDER BY sort_order ASC, id ASC`;
    done(null, rows);
  } catch (err) { done(err); }
}

exports.getAll = async function(done){
  try {
    const rows = await sql`SELECT * FROM homepage_announcement ORDER BY sort_order ASC, id ASC`;
    done(null, rows);
  } catch (err) { done(err); }
}

exports.getById = async function(id, done){
  try {
    const rows = await sql`SELECT * FROM homepage_announcement WHERE id = ${id}`;
    done(null, rows[0]);
  } catch (err) { done(err); }
}

exports.create = async function(data, done){
  try {
    const rows = await sql`
      INSERT INTO homepage_announcement
        (title, teaser_html, modal_body_html, image_url, show_gallery_link, sort_order, active)
      VALUES
        (${data.title}, ${data.teaser_html}, ${data.modal_body_html}, ${data.image_url},
         ${data.show_gallery_link}, ${data.sort_order}, ${data.active})
      RETURNING *`;
    done(null, rows[0]);
  } catch (err) { done(err); }
}

exports.updateById = async function(id, data, done){
  try {
    const rows = await sql`
      UPDATE homepage_announcement SET
        title = ${data.title},
        teaser_html = ${data.teaser_html},
        modal_body_html = ${data.modal_body_html},
        image_url = ${data.image_url},
        show_gallery_link = ${data.show_gallery_link},
        sort_order = ${data.sort_order},
        active = ${data.active},
        updated_at = now()
      WHERE id = ${id}
      RETURNING *`;
    done(null, rows[0]);
  } catch (err) { done(err); }
}

exports.deleteById = async function(id, done){
  try {
    const rows = await sql`DELETE FROM homepage_announcement WHERE id = ${id}`;
    done(null, rows);
  } catch (err) { done(err); }
}
