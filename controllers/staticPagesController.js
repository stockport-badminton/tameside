require('dotenv').config()
const contentful = require('contentful')
let { documentToHtmlString } = require('@contentful/rich-text-html-renderer');
const seasonModel = require('../models/season');

// Season archive: lists every past season that has an archived data snapshot,
// newest first. Reads live from the DB so newly-archived seasons appear without
// a redeploy.
exports.history = async function(req, res, next) {
    try {
        const seasons = await seasonModel.getAll();
        res.render('history', {
            pageHeading: 'Season Archive',
            title: 'Season Archive',
            pageDescription: 'Final league tables and results for past Tameside Badminton League seasons.',
            static_path: '/static',
            seasons: seasons
        });
    } catch (err) {
        next(err);
    }
}

const client = contentful.createClient({
    space: process.env.CONTENTFUL_SPACE,
    environment: 'master', // defaults to 'master' if not set
    accessToken: process.env.CONTENTFUL_KEY
})


exports.rules = function(req, res, next) {
  client.getEntry('1MRfswcqj2z6h7Ph47LFHs')
  .then((entry) => {
      // console.log(entry)
      const rawRichTextField = entry.fields.richTextField;
      // console.log(rawRichTextField)
      return documentToHtmlString(rawRichTextField);
    })
    .then((renderedHtml) => {
      renderedHtml = renderedHtml.replace(/<li><p> <\/p><ol><li>/g,"<li><p> </p><ol type=\"a\"><li>")
      renderedHtml = renderedHtml.replace(/<li><p><\/p><ol><li>/g,"<li><p> </p><ol type=\"a\"><li>")
      renderedHtml = renderedHtml.replace(/Shield<\/h3><ol>/g,"Shield</h3><ol start=\"21\">")
      renderedHtml = renderedHtml.replace(/Scoring.<\/h3><ol>/g,"Scoring.</h3><ol type=\"a\" start=\"2\">")
      renderedHtml = renderedHtml.replace(/Adjustment.<\/h3><ol>/g,"Adjustment.</h3><ol type=\"a\" start=\"10\">")
      renderedHtml = renderedHtml.replace(/Eligibility.<\/h3><ol>/g,"Eligibility.</h3><ol type=\"a\" start=\"12\">")
      renderedHtml = renderedHtml.replace(/Shuttles.<\/h3><ol>/g,"Shuttles.</h3><ol type=\"a\" start=\"16\">")
      renderedHtml = renderedHtml.replace(/Tournaments<\/h3><ol>/g,"Tournaments</h3><ol start=\"22\">")
      renderedHtml = renderedHtml.replace(/Officials<\/h3><ol>/g,"Officials</h3><ol start=\"23\">")
      renderedHtml = renderedHtml.replaceAll(/\n/g,"<br />")
      // console.log(renderedHtml)
      res.render('rules',{
          pageHeading:"Tameside Badminton League Rules",
          title:"Tameside Badminton League Rules",
          pageDescription:"Tameside Badminton League Rules",
          entry:renderedHtml,
          static_path : "/static" 
      })
    }) 
  .catch(console.error) 
}

