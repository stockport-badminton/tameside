const mailjet = require ('node-mailjet').apiConnect(process.env.MAILJET_KEY, process.env.MAILJET_SECRET)
var Club = require('../models/club.js');
//var Player = require('../models/players.js');
require('dotenv').config()
const { body,validationResult } = require("express-validator");
const { sanitizeBody } = require("express-validator");
var axios = require('axios');
const { read } = require('fs');
const fs = require('fs');

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


function containsProfanity(value,{req}){
  var substringsArray = ["Website Design","Bing","SEO","Digital Marketing","Consultant","000***","brokerage","pharm","Blockchain","blockchain","@Cryptaxbot","pharma","mail.ru","@FeedbackMessages","messages exploitation","Financial Strategic Firm","Business Financial Team","Christ","God","http://","http","https","wininphone","corta.co","Cryptocurrency","adultdating","forex","ahole","anus","ash0le","ash0les","asholes","ass","Ass Monkey","Assface","assh0le","assh0lez","asshole","assholes","assholz","asswipe","azzhole","bassterds","bastard","bastards","bastardz","basterds","basterdz","Biatch","bitch","bitches","Blow Job","boffing","butthole","buttwipe","c0ck","c0cks","c0k","Carpet Muncher","cawk","cawks","Clit","cnts","cntz"," cock","cockhead","cock-head","cocks","CockSucker","cock-sucker","crap","cum","cunt","cunts","cuntz","dick","dild0","dild0s","dildo","dildos","dilld0","dilld0s","dominatricks","dominatrics","dominatrix","dyke","enema","f u c k","f u c k e r","fag","fag1t","faget","fagg1t","faggit","faggot","fagit","fags","fagz","faig","faigs","fart","flipping the bird","fuck","fucker","fuckin","fucking","fucks","Fudge Packer","fuk","Fukah","Fuken","fuker","Fukin","Fukk","Fukkah","Fukken","Fukker","Fukkin","g00k","gay","gayboy","gaygirl","gays","gayz","God-damned","h00r","h0ar","h0re","hells","hoar","hoor","hoore","jackoff","jap","japs","jerk-off","jisim","jiss","jizm","jizz","knob","knobs","knobz","kunt","kunts","kuntz","Lesbian","Lezzian","Lipshits","Lipshitz","masochist","masokist","massterbait","masstrbait","masstrbate","masterbaiter","masterbate","masterbates","Motha Fucker","Motha Fuker","Motha Fukkah","Motha Fukker","Mother Fucker","Mother Fukah","Mother Fuker","Mother Fukkah","Mother Fukker","mother-fucker","Mutha Fucker","Mutha Fukah","Mutha Fuker","Mutha Fukkah","Mutha Fukker","n1gr","nastt","nigger;","nigur;","niiger;","niigr;","orafis","orgasim;","orgasm","orgasum","oriface","orifice","orifiss","packi","packie","packy","paki","pakie","paky","pecker","peeenus","peeenusss","peenus","peinus","pen1s","penas","penis","penis-breath","penus","penuus","Phuc","Phuck","Phuk","Phuker","Phukker","polac","polack","polak","Poonani","pr1c","pr1ck","pr1k","pusse","pussee","pussy","puuke","puuker","queer","queers","queerz","qweers","qweerz","qweir","recktum","rectum","retard","sadist","scank","schlong","screwing","semen","sex","sexy","Sh!t","sh1t","sh1ter","sh1ts","sh1tter","sh1tz","shit","shits","shitter","Shitty","Shity","shitz","Shyt","Shyte","Shytty","Shyty","skanck","skank","skankee","skankey","skanks","Skanky","slut","sluts","Slutty","slutz","son-of-a-bitch","tit","turd","va1jina","vag1na","vagiina","vagina","vaj1na","vajina","vullva","vulva","w0p","wh00r","wh0re","whore","xrated","xxx","b!+ch","bitch","blowjob","clit","arschloch","fuck","shit","ass","asshole","b!tch","b17ch","b1tch","bastard","bi+ch","boiolas","buceta","c0ck","cawk","chink","cipa","clits","cock","cum","cunt","dildo","dirsa","ejakulate","fatass","fcuk","fuk","fux0r","hoer","hore","jism","kawk","l3itch","l3i+ch","lesbian","masturbate","masterbat*","masterbat3","motherfucker","s.o.b.","mofo","nazi","nigga","nigger","nutsack","phuck","pimpis","pusse","pussy","scrotum","sh!t","shemale","shi+","sh!+","slut","smut","teets","tits","boobs","b00bs","teez","testical","testicle","titt","w00se","jackoff","wank","whoar","whore","*damn","*dyke","*fuck*","*shit*","@$$","amcik","andskota","arse*","assrammer","ayir","bi7ch","bitch*","bollock*","breasts","butt-pirate","cabron","cazzo","chraa","chuj","Cock*","cunt*","d4mn","daygo","dego","dick*","dike*","dupa","dziwka","ejackulate","Ekrem*","Ekto","enculer","faen","fag*","fanculo","fanny","feces","feg","Felcher","ficken","fitt*","Flikker","foreskin","Fotze","Fu(*","fuk*","futkretzn","gay","gook","guiena","h0r","h4x0r"," hell ","helvete","hoer*","honkey","Huevon","hui","injun","jizz","kanker*","kike","klootzak","kraut","knulle","kuk","kuksuger","Kurac","kurwa","kusi*","kyrpa*","lesbo","mamhoon","masturbat*","merd*","mibun","monkleigh","mouliewop","muie","mulkku","muschi","nazis","nepesaurio","nigger*","orospu","paska*","perse","picka","pierdol*","pillu*","pimmel","piss*","pizda","poontsee","poop","porn","p0rn","pr0n","preteen","pula","pule","puta","puto","qahbeh","queef*","rautenberg","schaffer","scheiss*","schlampe","schmuck","screw","sh!t*","sharmuta","sharmute","shipal","shiz","skribz","skurwysyn","sphencter","spic","spierdalaj","splooge","suka","b00b*","testicle*","titt*","twat","vittu","wank*","wetback*","wichser","wop*","zabourah"];

  if (substringsArray.some(function(v) { if (value.indexOf(v) >= 0) {console.log(v)}; return value.indexOf(v) >= 0; })) {
     logger.log('containsProfanity fail')
    // console.log('containsProfanity fail')
    return false
  }
  // if (substringsArray.some(substring=>yourBigString.includes(substring))) {

  // }
  else{
    // console.log('containsProfanity sucess')
     console.log(value)
    return value
  }
}

function containsDodgyEmail(value,{req}){
  var substringsArray = ["seorankingtech@gmail.com","denisberger.web@gmail.com","dianacruz.mkt@gmail.com","applicationdevelopment03@gmail.com","bemibrooks.dev@gmail.com","pageranktechnology@gmail.com","sales@rankinghat.co","yjdisantoyjdissemin@gmail.com","lucido.leinteract@gmail.com","projectdept@kanzalshamsprojectmgt.com","evalidator.test@gmail.com","simpsonmiddleton1111@gmail.com","simpsonmiddleton@bankingandfinanceconsultantsltd.com","breiner@cljfarmaceutisch.nl","drbreiner233@gmail.com","smithduncan610@gmail.com","5rdhp2fe29yb@beconfidential.com","stevenlove88@163.com","artweb.agency@gmail.com","help@aweb.sbs","hrhbah-mbi@aghemfondom.com","hrhmbambi@gmail.com","nhu-tran@sac-city.k12.ca.us","yourmail@gmail.com","kaenquirynicholls@gmail.com"];

  if (substringsArray.some(function(v) { if (value.indexOf(v) >= 0) {console.log(v)}; return value.indexOf(v) >= 0; })) {
     logger.log('dodgyEmail fail')
    // console.log('containsProfanity fail')
    return false
  }
  // if (substringsArray.some(substring=>yourBigString.includes(substring))) {

  // }
  else{
    // console.log('containsProfanity sucess')
     console.log(value)
    return value
  }
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
      "HTMLPart": "<p>a new user has signed up: "+ req.body.user +"<br /><a href=\"https://tameside-badminton.co.uk/approve-user/"+req.body.id+"\">Approve?</a></p>",
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
        "Email": "bigcoops+tamesidewebsite@gmail.com"
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
          msg.To = [{"Email":"jbutleruk@gmail.com"}]
          msg.cc = null;
          break;
        case 'secretary':
          msg.To = [{"Email":"santanareedy@btinernet.com"}]
          break;
        case 'chair':
          msg.To = [{"Email":"stuart728turner@btinternet.com"}]
          break;
        case 'lewis':
          msg.To = [{"Email":"jbutleruk@gmail.com"}]
          break;
        case 'website':
          msg.To = [{"Email":"bigcoops+tamesidewebsite@gmail.com"}]
          break;
          case 'fixtures':
            msg.To = [{"Email":"bigcoops+tamesidefixtures@gmail.com"}]
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