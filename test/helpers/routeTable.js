// The walker lives in utils/routeTable.js since GET /robots.txt is built from it at run
// time (utils/robots.js). Re-exported here so the tests keep their import.
module.exports = require('../../utils/routeTable');
