const postgres = require('postgres')

const sql = postgres(
  `postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,
  {
    ssl: { rejectUnauthorized: false },
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  }
)

module.exports = { sql }
