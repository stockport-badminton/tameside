const mailjet = require ('node-mailjet').apiConnect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET)

exports.getManagementAPIKey = async function(done){
  try {
    const res = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.AUTH0_CLIENTID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        audience: 'https://stockport-badminton.eu.auth0.com/api/v2/',
        grant_type: 'client_credentials'
      })
    });
    const body = await res.json();
    if (body.access_token) {
      return done(null, body.access_token);
    } else {
      return done(null, 'token fail');
    }
  } catch(err) {
    return done(err);
  }
}

exports.getAPIKey = async function(done){
  try {
    const res = await fetch(`https://${process.env.AUTH0_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.AUTH0_CLIENTID,
        client_secret: process.env.AUTH0_CLIENT_SECRET,
        audience: 'http://tameside-badminton.co.uk',
        grant_type: 'client_credentials'
      })
    });
    const body = await res.json();
    if (body.access_token) {
      done(body.access_token);
    } else {
      done('token fail');
    }
  } catch(err) {
    done(err);
  }
}

exports.grantResultsAccess = function(req, res, next){
  module.exports.getManagementAPIKey(async function(err, apiKey){
    if (err) {
      return next(err);
    }
    try {
      const userRes = await fetch(`https://${process.env.AUTH0_DOMAIN}/api/v2/users/${req.params.userId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ app_metadata: { betaAccess: true } })
      });
      const userBody = await userRes.json();

      const msg = {
        From: { Email: 'website@tameside-badminton.co.uk' },
        To: [{ Email: userBody.email }],
        Bcc: [{ Email: 'tameside.badders.results@gmail.com' }],
        Subject: 'Result Entry Access',
        TextPart: "Thanks for registering - i've approved your access",
        HTMLPart: "<p>Thanks for registering - i've approved your access</p>"
      };

      await mailjet.post('send', { version: 'v3.1' }).request({ Messages: [msg] });
      res.render('userapproved', {
        static_path: '/static',
        theme: process.env.THEME || 'flatly',
        title: 'Results Access Approved',
        pageDescription: 'Results Access Approved',
        result: JSON.stringify(userBody)
      });
    } catch(err) {
      next('Sorry something went wrong approving access.');
    }
  });
}
