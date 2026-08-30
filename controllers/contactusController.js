const mailjet = require ('node-mailjet').apiConnect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET)
var Club = require('../models/club.js');
var Player = require('../models/players.js');
var Division = require('../models/division.js');
require('dotenv').config()
const { body,validationResult } = require("express-validator");
const { sanitizeBody } = require("express-validator");
var axios = require('axios');
const { read } = require('fs');
const fs = require('fs');
var Spam = require('../models/spamControls');
const spamGate = require('../middleware/spamGate');

// Test seam, mirroring fixtureController._mailjetClientForTesting: lets the suite stub
// `post` so a submission test never sends a real email.
exports._mailjetClientForTesting = mailjet;

exports.mailjet_test = function(req,res,next) {
    
    const request = mailjet
    .post("send", {'version': 'v3.1'})
    .request({
    "Messages":[
        {
        "From": {
            "Email": "results@tameside-badminton.co.uk",
            "Name": "Neil"
        },
        "To": [
            {
            "Email": "tameside.badders.results@gmail.com",
            "Name": "Neil"
            }
        ],
        "Subject": "Greetings from Mailjet.",
        "TextPart": "My first Mailjet email",
        "HTMLPart": "<h3>Dear passenger 1, welcome to <a href='https://www.mailjet.com/'>Mailjet</a>!</h3><br />May the delivery force be with you!",
        "CustomID": "AppGettingStartedTest"
        }
    ]
    })
    .then((result) => {
        console.log(result.body)
        res.send(result.body)
    })
    .catch((err) => {
        console.log(err.statusCode)
        next(err)
    })
}

function validCaptcha(value,{req}){
  // console.log('https://www.google.com/recaptcha/api/siteverify?secret='+ process.env.RECAPTCHA_SECRET +'&response='+value);
  axios.post("https://www.google.com/recaptcha/api/siteverify?secret="+ process.env.RECAPTCHA_SECRET +"&response="+value)
    .then(response => {
      //console.log(response.request)
      //console.log(response.config)
      //console.log(response.data)
      if (response.data.success){
        // console.log('recaptcha sucess')
        return value
      }
      else {
        console.log('recaptcha fail')
        return false
      }
    })
    .catch(err => {
      console.log("error")
      console.log(err)
      return false
    })
}


// The two blocklist validators. Both used to carry their list inline: ~180 phrases here
// and 26 email addresses below. They now read the blocked_entry table via
// models/spamControls, so blocking a spammer is a form submission on /admin/spam rather
// than an edit to this file followed by a deploy. See migrations/spam-controls.sql.
//
// `req._spamReason` is picked up by the handler so the submission log can tell a blocklist
// hit apart from a real person getting a field wrong.
//
// Kept as express-validator `.custom()` functions with the same names and the same
// false-means-reject contract, so validateContactUs below is unchanged in shape.

// Named for what it used to be. It now matches whatever is in the table — the profanity
// list it was built around was deliberately not carried over (see the migration for why:
// it contained "ass", "sex", "gay" and "hell" as bare substrings, and the spam half had
// "Christ" and "God", which block Christine, Christopher, Goddard and Godfrey).
// These MUST throw to reject, not return false.
//
// express-validator 7.x treats a *synchronous* validator returning a falsy value as a
// failure, but an async one is judged on whether its promise rejects — resolving to `false`
// is a silent pass. The previous versions of these two functions were synchronous (their
// lists were inline arrays) so `return false` worked; reading the blocklist from the DB
// makes them async, and keeping `return false` turned both blocklists into no-ops that let
// every submission through to Mailjet. Verified against express-validator 7.3.0.
async function containsProfanity(value,{req}){
  const hit = await Spam.matchBlockedText(value)
  if (hit) {
    req._spamReason = 'blocked-' + hit.kind
    // .withMessage() below replaces this text; it just has to reject.
    throw new Error('blocked-' + hit.kind)
  }
  return value
}

async function containsDodgyEmail(value,{req}){
  if (await Spam.isBlockedEmail(value)) {
    req._spamReason = 'blocked-email'
    throw new Error('blocked-email')
  }
  return value
}


exports.validateContactUs = [
  body('contactEmail').not().isEmpty().withMessage('please enter an Email address').isEmail().withMessage('Please enter a valid email address').custom(containsDodgyEmail).withMessage("You have been blocked for spamming the contact form"),
  body('contactQuery').not().isEmpty().withMessage('Please enter something in message field.').custom(containsProfanity).withMessage("Please don't use profanity in the message body"),
  body('g-recaptcha-response').not().custom(validCaptcha).withMessage('your not a human')
]

exports.new_user = function(req,res,next){
  const msg = {
    "From": {
      "Email": "results@tameside-badminton.co.uk"
    },
    "ReplyTo": {
      "Email": "results@tameside-badminton.co.uk"
    },
    "To": [
      {
        "Email": "results@tameside-badminton.co.uk"
      }
    ],
    "Subject": "new user signup",
    "TextPart": "a new user has signed up: " + req.body.user,
      // Auth0 ids contain a `|` ("auth0|abc123"), which went into the emailed link
      // raw. Encode it so the link survives the mail client and matches the route.
      "HTMLPart": "<p>a new user has signed up: "+ req.body.user +"<br /><a href=\"https://tameside-badminton.co.uk/approve-user/"+encodeURIComponent(req.body.id)+"\">Approve?</a></p>",
      "CustomID": "UserSignUp"
  }
  
  if (typeof req.body.id != 'undefined' && req.body.id.length > 3 && req.body.id != 'undefined'){
    const request = mailjet
        .post("send", {'version': 'v3.1'})
        .request({
        "Messages":[msg]})
    .then(()=>{
      res.sendStatus(200)
    })
    .catch(error => {
      console.log(error.toString());
      return next("Sorry something went wrong sending your email.");
    })
  }
  else{
    res.sendStatus(200);
  }
}

exports.contactus = function(req, res,next){
  console.log(req.body)
  var errors = validationResult(req);
  if (!errors.isEmpty()) {
      console.log("errors array");
      console.log(errors.array());
      // `req._spamReason` is set by the blocklist validators; anything else that failed
      // validation is a real person getting a field wrong, which is worth telling apart
      // from spam in the log. A rising 'validation' count on /admin/spam means the form
      // itself is the problem.
      spamGate.logOutcome(req, {
        verdict: 'rejected',
        reason: req._spamReason || 'validation',
      });
      res.render('contact-us-form-delivered', {
        title: 'Contact Us - Error',
        pageDescription: 'Sorry we weren\'t able sent your email - something went wrong',
        message: 'Sorry something went wrong',
        static_path:'/static',
        content: errors.array()
      });
      return;
  }
  else {
  const msg = {
    "From": {
      "Email": "results@tameside-badminton.co.uk"
    },
    "ReplyTo": {
      "Email": req.body.contactEmail
    },
    "To": [
      {
        "Email": "passenger1@example.com"
      }
    ],
    "Bcc": [
      {
        "Email": "tameside.badders.results@gmail.com"
      }
    ],
    "TemplateID": 6134550,
    "TemplateLanguage": true,
    "Subject": "Someone is trying to get in touch",
    "Variables": {
  "message": req.body.contactQuery,
  "email": req.body.contactEmail
}
  };
    var clubEmail = '';

    // Neither branch below matches unless contactType is exactly 'Clubs' or 'League', and
    // there was no else — so a POST with a missing or unrecognised contactType fell off the
    // end of this function without ever sending a response. The request then hung until the
    // client or Cloud Run timed it out, holding a connection the whole time. That is
    // reachable by anyone posting to this endpoint without the field, which is precisely
    // what a bot does, so it matters more now the form is being hardened.
    if (req.body.contactType !== 'Clubs' && req.body.contactType !== 'League') {
      spamGate.logOutcome(req, { verdict: 'rejected', reason: 'validation' });
      return res.status(400).render('contact-us-form-delivered', {
        static_path: '/static',
        title: 'Contact Us - Error',
        pageDescription: 'Sorry we weren\'t able sent your email - something went wrong',
        message: 'Sorry something went wrong',
        content: [{ msg: 'Please choose who you want to contact.' }]
      });
    }

    if(req.body.contactType == 'Clubs'){
      Club.getContactDetailsById(req.body.clubSelect, function(err,rows){
        if (err){
          console.log(err);
          next(err);
        }
        else {
          // msg.to = rows[0].contactUs;
          // msg.to = (rows[0].clubSecEmail.indexOf(',') > 0 ? rows[0].clubSecEmail.split(',') : rows[0].clubSecEmail);
          msg.To = rows.map(row => ({"Email":row.clubSecEmail,"Name":row.clubSecretary}))
          const request = mailjet
          .post("send", {'version': 'v3.1'})
          .request({
          "Messages":[msg]})
            .then(()=>{
              console.log(msg);
              res.render('contact-us-form-delivered', {
                  static_path: '/static',
                  title: 'Contact Us - Success',
                  pageDescription: 'Success - we\'ve sent an email to your chosen contact for you',
                  message: 'Success - we\'ve sent your email to your chosen contact'
              });
            })
            .catch(error => {
              console.log(error.toString());
              return next("Sorry something went wrong sending your email.");
            })
        }
      })
      
    }
    if (req.body.contactType == 'League'){
      switch (req.body.leagueSelect) {
        case 'results':
          msg.To = [{"Email":"tameside.badders.results@gmail.com"}]
          msg.cc = null;
          break;
        case 'secretary':
          msg.To = [{"Email":"santanareedy@btinternet.com"}]
          break;
        case 'chair':
          msg.To = [{"Email":"stuart728turner@btinternet.com"}]
          break;
        case 'lewis':
          msg.To = [{"Email":"jbutleruk@gmail.com"}]
          break;
        case 'website':
          msg.To = [{"Email":"tameside.badders.results@gmail.com"}]
          break;
          case 'fixtures':
            msg.To = [{"Email":"tameside.badders.results@gmail.com"}]
            break;
        case 'treasurer':
          msg.To = [{"Email":"david.jackson@crawleyandco.com"}]
          break;
          case 'handbook':
            msg.To = [{"Email":"gillian.indexer@gmail.com"}]
            break;
        default:
      }
      const request = mailjet
          .post("send", {'version': 'v3.1'})
          .request({
          "Messages":[msg]})
      .then(()=>{
        console.log(msg);
        spamGate.logOutcome(req, { verdict: 'accepted' });
        res.render('contact-us-form-delivered', {
            static_path: '/static',
            title: 'Contact Us - Success',
            pageDescription: 'Success - we\'ve sent an email to your chosen contact for you',
            message: 'Success - we\'ve sent your email to your chosen contact'
        });
      })
      .catch(error => {
        console.log(error.toString());
        return next("Sorry something went wrong sending your email.");
      })
    }
  }
}

exports.contactus_get = function(req, res,next) {
    Club.getAll(function(err,rows){
      if(err){
        console.log(err);
        next(err);
      }
      else {
        res.render('contact-us-form', {
          static_path: '/static',
          title : "Contact Us",
          pageDescription : "Get in touch with your league representatives, or club secretaries",
          recaptcha : process.env.RECAPTCHA,
          clubs:rows
        });
      }
        
    })
    
  }
/* ------------------------------------------------------------------ *
 * Superadmin distribution lists.
 * Build a recipient list by role (+ optional division / club / team) via
 * Player.getEmails, preview it, and send a message to it with Mailjet (the
 * list goes in Bcc so recipients don't see each other).
 * ------------------------------------------------------------------ */

const _promisify = fn => (...args) => new Promise((resolve, reject) =>
  fn(...args, (err, result) => err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(result)));

// Shared with every other admin-gated controller — utils/authz.js owns the claim key.
const { isSuperAdmin: _isSuperAdmin } = require('../utils/authz');

const _getEmailsP    = _promisify(Player.getEmails);
const _getAllClubsP  = _promisify(Club.getAll);
const _getAllDivisionsP = _promisify(Division.getAll);

// Role options: label shown in the UI -> value stored in getEmails' `role` column.
const DIST_ROLES = [
  { value: 'match Sec',    label: 'Match Secretaries' },
  { value: 'club Sec',     label: 'Club Secretaries' },
  { value: 'team Captain', label: 'Team Captains' },
  { value: 'treasurer',    label: 'Treasurers' },
  { value: 'otherComms',   label: 'Other / League Comms' },
];

function _searchObjFromBody(body) {
  const s = {};
  if (body.role)     s.role = body.role;
  if (body.division) s.division = body.division;
  if (body.club)     s.club = body.club;
  if (body.teamName) s.teamName = body.teamName;
  return s;
}

exports.admin_distribution_form = async function(req, res, next) {
  if (!_isSuperAdmin(req)) return res.status(403).send('Forbidden');
  try {
    const [clubs, divisions] = await Promise.all([_getAllClubsP(), _getAllDivisionsP()]);
    res.render('admin/distribution', {
      static_path: '/static',
      title: 'Distribution Lists',
      pageDescription: 'Send an email to a role-based distribution list.',
      roles: DIST_ROLES,
      clubs: clubs,
      divisions: divisions.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0))
    });
  } catch (err) { next(err); }
};

// AJAX: return the resolved recipient list for the current filters.
exports.admin_distribution_preview = async function(req, res, next) {
  if (!_isSuperAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const emails = await _getEmailsP(_searchObjFromBody(req.body));
    res.json({ count: emails.length, emails: emails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.admin_distribution_send = async function(req, res, next) {
  if (!_isSuperAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();
  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are both required.' });
  }
  try {
    const emails = await _getEmailsP(_searchObjFromBody(req.body));
    if (!emails.length) {
      return res.status(400).json({ error: 'No recipients match those filters.' });
    }
    const html = '<div>' + message.replace(/\n/g, '<br />') + '</div>';
    const msg = {
      "From":    { "Email": "results@tameside-badminton.co.uk", "Name": "Tameside Badminton League" },
      "ReplyTo": { "Email": "results@tameside-badminton.co.uk" },
      // Visible To is the league address; the list itself goes in Bcc so
      // recipients never see each other's addresses.
      "To":  [{ "Email": "results@tameside-badminton.co.uk" }],
      "Bcc": emails.map(e => ({ "Email": e })),
      "Subject": subject,
      "TextPart": message,
      "HTMLPart": html,
      "CustomID": "DistributionList"
    };
    await mailjet.post("send", { 'version': 'v3.1' }).request({ "Messages": [msg] });
    res.json({ ok: true, sent: emails.length });
  } catch (err) {
    console.error('distribution send failed:', err && err.toString());
    res.status(500).json({ error: 'Sending failed — please try again.' });
  }
};
