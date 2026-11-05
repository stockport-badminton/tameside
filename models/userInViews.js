const authz = require('../utils/authz');

module.exports = function() {
    return function (req, res, next) {
      res.locals.user = req.user;
      // The club whose stats this login may see (utils/authz.js memberClub), so the nav
      // offers the stats pages on exactly the rule the pages enforce.
      res.locals.memberClub = authz.memberClub(req);
      // console.log("req.user: " + JSON.stringify(req.user))
      next();
    };
  };
