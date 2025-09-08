var request = require('request');
const mailjet = require ('node-mailjet').apiConnect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET)

exports.getManagementAPIKey = function(done){
  var options = {
        method:'POST',
        url:'https://'+ process.env.AUTH0_DOMAIN +'/oauth/token',
        body:{
            "client_id":process.env.AUTH0_CLIENTID,
            "client_secret":process.env.AUTH0_CLIENT_SECRET,
            "audience":"https://stockport-badminton.eu.auth0.com/api/v2/",
            "grant_type":"client_credentials"
        },
        json:true
      }
      // console.log(options);
      request(options,function(err,response,body){
        if (err){
          console.log("getManagementAPIKey error");
          console.log(err)
          return done(err);
        }
        else {
          //console.log(body)
          if (body.access_token){
            console.log('token granted')
            return done(null,body.access_token)
          }
          else {
            console.log('recaptcha fail')
            return done(null,"token fail")
          }
        }

      })
}

exports.getAPIKey = function(done){
    var options = {
          method:'POST',
          url:'https://'+ process.env.AUTH0_DOMAIN +'/oauth/token',
          body:{
              "client_id":process.env.AUTH0_CLIENTID,
              "client_secret":process.env.AUTH0_CLIENT_SECRET,
              "audience":"http://tameside-badminton.co.uk",
              "grant_type":"client_credentials"
          },
          json:true
        }
        // console.log(options);
        request(options,function(err,response,body){
          if (err){
            console.log(err)
            return done(err)
          }
          else {
            // console.log(body)
            if (body.access_token){
              // console.log('token granted')
              done(body.access_token)
            }
            else {
              // console.log('recaptcha fail')
              done("token fail")
            }
          }
  
        })
  }

  exports.grantResultsAccess = function(req,res,next){
    module.exports.getManagementAPIKey(function(err,apiKey){
    if (err){
      next(err);
    }
    else{
      var options = {
        method:'PATCH',
        headers:{
          "Authorization":"Bearer "+apiKey
        },
        url:'https://'+process.env.AUTH0_DOMAIN+'/api/v2/users/'+req.params.userId,
        body:{
          app_metadata:{
            "betaAccess":true
          }
        },
        json:true
      }
      console.log(options);
      request(options,function(err,response,userBody){
        //console.log(options);
        if (err){
          res.error(err);
        }
        else{   
          const msg = {
            "From": {
              "Email": "website@tameside-badminton.co.uk"
            },
            "To": [
              {
                "Email": userBody.email
              }
            ],
            "Bcc": [
              {
                "Email": "tameside.badders.results@gmail.com"
              }
            ],
            "Subject": "Result Entry Access",
            "TextPart": "Thanks for registering - i\'ve approved your access",
            "HTMLPart": "<p>Thanks for registering - i\'ve approved your access</p>"
          };

          const request = mailjet
          .post("send", {'version': 'v3.1'})
          .request({
          "Messages":[msg]})
              .then(()=>{
                //console.log(msg)
                res.render('userapproved',{
                  static_path:'/static',
                  theme:process.env.THEME || 'flatly',
                  title : "Results Access Approved",
                  pageDescription : "Results Access Approved",
                  result:JSON.stringify(userBody)
                });
              })
              .catch(error => {
                console.log(error.toString());
                next("Sorry something went wrong sending your email.");
              })   
          
        }
      })
    }
  })
  }