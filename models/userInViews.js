module.exports = function() {
    return function (req, res, next) {
      res.locals.user = req.user;
      // console.log("req.user: " + JSON.stringify(req.user))
      next();
    };
  };
  