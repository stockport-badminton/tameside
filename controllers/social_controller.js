

const { getAllLeagueTables } = require('../models/league');
const fs = require('fs');
const Jimp = require('jimp')

exports.social_get_result = async function(req,res,next){
    // Path to the existing background image
    const backgroundImagePath = './static/images/bg/social-'+ req.params.division.replace(/([\s]{1,})/g,'-') +'.png';
    const background = await Jimp.read(backgroundImagePath);
    // Text settings
    const linesOfText = ["Result: "+ req.params.homeTeam +" vs ", req.params.awayTeam,req.params.homeScore +"-"+ req.params.awayScore,"#tameside #badminton #tbl #result","https://tameside-badminton.co.uk"];
    let textSize = 60;
    const lineHeight = 1.5; // Line height multiplier

    // Get the metadata of the image (e.g., dimensions)
    const bigFont = await Jimp.loadFont('./fonts/ArialBold_Black_60.fnt');
    const littleFont = await Jimp.loadFont('./fonts/ArialBold_Black_30.fnt');
    const { width, height } = background.bitmap;

    // Calculate where to start rendering the text (centered vertically)
    const totalTextHeight = linesOfText.length * textSize * lineHeight;
    let currentY = 500+ ((height / 2) - (totalTextHeight / 2));
    // Prepare the complete text with inline HTML-style formatting (if desired)
    for (index in linesOfText){
      textSize = index > 2 ? 30 : 60
      background.print(
        index > 2 ? littleFont:bigFont,
        10, // X position
        currentY, // Y position (increment for each line)
        {
          text: linesOfText[index],
          alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT
        },
        width, // Max width for alignment
        textSize // Max height for alignment
      );
      currentY += textSize * lineHeight;
    }
    await background.writeAsync('static/images/generated/'+ req.params.homeTeam.replace(/([\s]{1,})/g,'-') + req.params.awayTeam.replace(/([\s]{1,})/g,'-') +'.png');
    
    res.setHeader('Content-Type', 'image/png');

    // Get the image buffer and send it to the browser
    const buffer = await background.getBufferAsync(Jimp.MIME_PNG);
    res.send(buffer);
  }

  exports.social_get_tables = function(req,res,next) {

    getAllLeagueTables(req.params.season,async function(err,result){
      if (err){
        console.log(err);
        next(err);
      }
      else {
        // console.log(result)
        var newResultsArray = []
        var divIds = [8,9]
        for (div of divIds){
          var divObject = {}
          var divArray = await result.filter(row => row.division == div).map(obj => {
            return {
              divisionName:obj.divisionName,
              name: obj.name,
              points: (obj.pointsFor === null ? 0 : obj.pointsFor ),
              played: obj.played,
              pointsAgainst:(obj.pointsAgainst === null ? 0 : obj.pointsAgainst ),
            };
          })
          // console.log(divArray);
          divObject[divArray[0].divisionName] = divArray
          newResultsArray.push(divObject)
        }
        // res.sendStatus(200)
        for (division of newResultsArray){

        //console.log(Object.entries(division))
        const lineHeight = 1.6; // Line height multiplier

    // Get the metadata of the image (e.g., dimensions)
        const bigFont = await Jimp.loadFont('./fonts/ArialBold_Black_65.fnt');
        const littleFont = await Jimp.loadFont('./fonts/Arial_Black_55.fnt');
        let textSize = 65
        
          for (let [key,value] of Object.entries(division)){
            let backgroundImagePath = './static/images/bg/social.png';
            let background = (await Jimp.read(backgroundImagePath)).resize(1080,1080)
            let { width, height } = background.bitmap;
            // Get the metadata of the image (e.g., dimensions)
            let posY = 10;
            let posX = 10
            let teamSpace = 600
            let numberSpace = 115
            let headerArray = [key,"P","W","L","Avg."]
            for (index in headerArray){
              background.print(
                index > 0 ? littleFont:bigFont,
                posX, // X position
                posY, // Y position (increment for each line)
                {
                  text: headerArray[index],
                  alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT
                },
                width, // Max width for alignment
                textSize // Max height for alignment
              );
              posX += index > 0 ? numberSpace:teamSpace
            }
            posY += textSize * lineHeight;
            let rowArray = []
            let avg = 0
            textSize = 55
            for (i in value){
              posX = 10
              avg = (value[i].points / value[i].played).toFixed(1)
              rowArray = [value[i].name,value[i].played,value[i].points,value[i].pointsAgainst,avg]
              // console.log(rowArray)
              for (j in rowArray){
                // console.log(rowArray[j])
                background.print(
                  littleFont,
                  posX, // X position
                  posY, // Y position (increment for each line)
                  {
                    text: rowArray[j].toString(),
                    alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT
                  },
                  width, // Max width for alignment
                  textSize // Max height for alignment
                );
                posX += j > 0 ? numberSpace:teamSpace
              }
              posY += (textSize+5) * lineHeight;
              
            }
            
            await background.writeAsync('static/images/generated/league-table-'+key+'.png');
            
          }  
        }
        res.sendStatus(200)
      }
  })
}