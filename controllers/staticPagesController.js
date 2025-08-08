require('dotenv').config()
let SEASON = '';
if (new Date().getMonth() < 6){
    SEASON = '' + new Date().getFullYear()-1 +'/'+ new Date().getFullYear();
}
else {
    SEASON = '' + new Date().getFullYear() +'/'+ (new Date().getFullYear()+1);
}
const contentful = require('contentful')
let { BLOCKS } = require('@contentful/rich-text-types') 
let { documentToHtmlString } = require('@contentful/rich-text-html-renderer');

const client = contentful.createClient({
    space: process.env.CONTENTFUL_SPACE,
    environment: 'master', // defaults to 'master' if not set
    accessToken: process.env.CONTENTFUL_KEY
})

exports.homepage = function(req, res, next) {
    client.getEntry('11CRuC0Q5OJb5a8vi4jsjX')
    .then((entry) => {
        // console.log(entry)
        const rawRichTextField = entry.fields.richTextField;
        // console.log(rawRichTextField)
        return documentToHtmlString(rawRichTextField);
      })
      .then((renderedHtml) => {
        res.render('homepage',{
            pageHeading:"Hyde Badminton Club",
            title:"Hyde Badminton Club",
            entry:renderedHtml,
            static_path : "/static" 
        })
      }) 
    .catch(console.error) 
}

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

exports.howToFindUs = (req, res, next) => {
    client.getEntry('4QOXYKaCKzdOrJAuXhraa')
    .then((entry) => {
        // console.log(entry)
        const rawRichTextField = entry.fields.richTextField;
        // console.log(rawRichTextField)
        return documentToHtmlString(rawRichTextField);
      })
      .then((renderedHtml) => {
        res.render('homepage',{
            pageHeading:"How to Find Us",
            title:"How to Find Us",
            entry:renderedHtml,
            static_path : "/static" 
        })
      }) 
    .catch(console.error) 
  }

exports.linksPage = (req, res, next) => {
    client.getEntry('5FLeCM0Gnxal5sOQoim0Kx')
    .then((entry) => {
        // console.log(entry)
        const rawRichTextField = entry.fields.richTextField;
        // console.log(rawRichTextField)
        return documentToHtmlString(rawRichTextField);
      })
      .then((renderedHtml) => {
        res.render('homepage',{
            pageHeading:"Links",
            title:"Links",
            entry:renderedHtml.replace(/\n/g, "</br>"),
            static_path : "/static" 
        })
      }) 
    .catch(console.error) 
  }

exports.galleryPage = (req, res, next) => {
    client.getEntry('IKaXhRQqSysI0udkAcZXZ')
    .then((entry) => {
        let carouselData = entry.fields.carouselImages.map(image => ({name:image.fields.imageName, caption:image.fields.imageCaption, source:image.fields.imageSource.fields.file.url}))
        // console.log(carouselData)
        res.render('gallery',{
            pageHeading:"Gallery",
            title:"Gallery",
            entry:carouselData,
            static_path : "/static" 
        })
      }) 
    .catch(console.error) 
  }

exports.newsPage = (req, res, next) => {
    client.getEntry('4wpiyFP9LOHKkl0x4xfOSi')
    .then((entry) => {
        // console.log(entry)
        let newsField = {}
        let pageHtml = ""
        for (newsItem of entry.fields.newsItems){
            pageHtml += "<div class=\"row\"><p class=\"mb-1\">"
            pageHtml += "<strong>"+ new Date(newsItem.fields.newsDate).toLocaleDateString("en-GB",{
                year: "numeric",
                month: "long",
                day: "numeric",
              })+ "</strong>&nbsp;"
            newsField = newsItem.fields.newsInfo
            // console.log(newsField)
            const options = {
                renderNode: {
                  [BLOCKS.PARAGRAPH]: (node,next) => next(node.content) + "</p>"
                }
              }
            pageHtml += documentToHtmlString(newsField,options);
            pageHtml += "</div>"
            // console.log(pageHtml)
        }
        res.render('homepage',{
          pageHeading:"News",
          title:"News",
          entry:pageHtml,
          static_path : "/static" 
        })
      }) 
    .catch(console.error) 
}

exports.contactUs = (req, res, next) => {
    client.getEntry('3iaUrVGwS68yA2R1AlioPL')
    .then((entry) => {
        // console.log(entry)
        const rawRichTextField = entry.fields.richTextField;
        // console.log(rawRichTextField)
        return documentToHtmlString(rawRichTextField);
      })
      .then((renderedHtml) => {
        res.render('homepage',{
            pageHeading:"Contact Us",
            title:"Contact Us",
            entry:renderedHtml.replaceAll("<table>","<table class=\"table-responsive table-bordered text-center\" style=\"max-width: 30rem\">").replaceAll("<td>","<td class=\"w-25\">"),
            static_path : "/static" 
        })
      }) 
    .catch(console.error) 
  }