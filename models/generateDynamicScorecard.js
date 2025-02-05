let scorecardConfig = 
    [
        {
            "step":4,
            "name":"FirstMens",
            "homePlayers":[
                "Man 1",
                "Man 2"
            ],
            "awayPlayers":[
                "Man 1",
                "Man 2"
            ]
        },
        {
            "step":5,
            "name":"FirstLadies",
            "homePlayers":[
                "Lady 1",
                "Lady 2"
            ],
            "awayPlayers":[
                "Lady 1",
                "Lady 2"
            ]
        },
        {
            "step":6,
            "name":"SecondMens",
            "homePlayers":[
                "Man 3",
                "Man 4"
            ],
            "awayPlayers":[
                "Man 3",
                "Man 4"
            ]
        },
        {
            "step":7,
            "name":"FirstMixed",
            "homePlayers":[
                "Man 1",
                "Lady 1"
            ],
            "awayPlayers":[
                "Man 1",
                "Lady 1"
            ]
        },
        {
            "step":8,
            "name":"SecondMixed",
            "homePlayers":[
                "Man 2",
                "Lady 2"
            ],
            "awayPlayers":[
                "Man 2",
                "Lady 2"
            ]
        },
        {
            "step":9,
            "name":"ThirdMixed",
            "homePlayers":[
                "Man 3",
                "Lady 1"
            ],
            "awayPlayers":[
                "Man 3",
                "Lady 1"
            ]
        },
        {
            "step":10,
            "name":"FourthMixed",
            "homePlayers":[
                "Man 4",
                "Lady 2"
            ],
            "awayPlayers":[
                "Man 4",
                "Lady 2"
            ]
        },
        {
            "step":11,
            "name":"ThirdMens",
            "homePlayers":[
                "Man 1",
                "Man 2"
            ],
            "awayPlayers":[
                "Man 3",
                "Man 4"
            ]
        },
        {
            "step":12,
            "name":"FourthMens",
            "homePlayers":[
                "Man 3",
                "Man 4"
            ],
            "awayPlayers":[
                "Man 1",
                "Man 2"
            ]
        }
    ];

let scorecardHTML = ""
let populatedScorecard = ""
let gameCount = -1
for (row of scorecardConfig){
    gameCount += 2
    scorecardHTML += `<div class="modal-body step step-${row.step} ${row.name}">

        <div class="form-group step-${row.step} ${row.name}">
          <label for="home${row.name}">Home ${row.name}</label>
          <select class="form-control playerInput" id="${row.name}home${row.homePlayers[0].replace(' ','')}" data-player-type="home${row.homePlayers[0].replace(' ','')}" name="${row.name}home${row.homePlayers[0].replace(' ','')}" placeholder="Home ${row.homePlayers[0]}">
          </select>
          <select class="form-control playerInput" id="${row.name}home${row.homePlayers[1].replace(' ','')}" data-player-type="home${row.homePlayers[1].replace(' ','')}" name="${row.name}home${row.homePlayers[1].replace(' ','')}" placeholder="Home ${row.homePlayers[1]}">
          </select>
        </div>
        <div class="form-group step-${row.step} ${row.name}">
          <label for="away${row.name}">Away ${row.name}</label>
          <select class="form-control playerInput" id="${row.name}away${row.awayPlayers[0].replace(' ','')}" data-player-type="away${row.awayPlayers[0].replace(' ','')}" name="${row.name}away${row.awayPlayers[0].replace(' ','')}" placeholder="Away ${row.awayPlayers[0]}">
          </select>
          <select class="form-control playerInput" id="${row.name}away${row.awayPlayers[1].replace(' ','')}" data-player-type="away${row.awayPlayers[1].replace(' ','')}" name="${row.name}away${row.awayPlayers[1].replace(' ','')}" placeholder="Away ${row.awayPlayers[1]}">
          </select>
        </div>
        <div class="form-row">
          <div class="form-group step-${row.step} ${row.name} col-6">
            <label for="game${gameCount}Score">Game ${gameCount}</label>
            <div class="form-row"><div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount} home" id="Game${gameCount}homeScore" name="Game${gameCount}homeScore" placeholder=""></div>
            <div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount} away" id="Game${gameCount}awayScore" name="Game${gameCount}awayScore" placeholder=""></div></div>
          </div>
          <div class="form-group step-${row.step} ${row.name} col-6">
            <label for="game${gameCount+1}Score">Game ${gameCount+1}</label>
            <div class="form-row"><div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount+1} home" id="Game${gameCount+1}homeScore" name="Game${gameCount+1}homeScore" placeholder=""></div>
            <div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount+1} away" id="Game${gameCount+1}awayScore" name="Game${gameCount+1}awayScore" placeholder=""></div></div>
          </div>
        </div>
        
        </div>`

        if (row.name.indexOf("Mixed") > 0){
            populatedScorecard += `<div class="modal-body step step-${row.step} ${row.name}">

        <div class="form-group step-${row.step} ${row.name}">
          <label for="home${row.name}">Home ${row.name}</label>
          <select class="form-control playerInput" id="${row.name}home${row.homePlayers[0].replace(' ','')}" data-player-type="home${row.homePlayers[0].replace(' ','')}" name="${row.name}home${row.homePlayers[0].replace(' ','')}" placeholder="Home ${row.homePlayers[0]}">
          <% result.homeMenRows.forEach(function(row){                       
                       if (row.id == data.homeMan1 || row.id == data.homeMan2 || row.id == data.homeMan3|| row.id == data.homeMan4){
                        if (row.id == data.${row.name}home${row.homePlayers[0].replace(' ','')}){
                          var selected = " selected"
                        }
                        else {
                          var selected = ""
                        } %>
                        <option value="<%= row.id %>" <%= selected %>><%= row.first_name %> <%= row.family_name %></option>                                              
                     <% }                       
                     }) %>
                      <option value="0">No Player Home Team</option>
                      <option value="0">No Player Away Team</option> 
          </select>
          <select class="form-control playerInput" id="${row.name}home${row.homePlayers[1].replace(' ','')}" data-player-type="home${row.homePlayers[1].replace(' ','')}" name="${row.name}home${row.homePlayers[1].replace(' ','')}" placeholder="Home ${row.homePlayers[1]}">
          <% result.homeLadiesRows.forEach(function(row){                       
                       if (row.id == data.homeLady1 || row.id == data.homeLady2){
                        if (row.id == data.${row.name}home${row.homePlayers[1].replace(' ','')}){
                          var selected = " selected"
                        }
                        else {
                          var selected = ""
                        } %>
                        <option value="<%= row.id %>" <%= selected %>><%= row.first_name %> <%= row.family_name %></option>                                              
                     <% }                       
                     }) %>
                      <option value="0">No Player Home Team</option>
                      <option value="0">No Player Away Team</option> 
          </select>
        </div>
        <div class="form-group step-${row.step} ${row.name}">
          <label for="away${row.name}">Away ${row.name}</label>
          <select class="form-control playerInput" id="${row.name}away${row.awayPlayers[0].replace(' ','')}" data-player-type="away${row.awayPlayers[0].replace(' ','')}" name="${row.name}away${row.awayPlayers[0].replace(' ','')}" placeholder="Away ${row.awayPlayers[0]}">
          <% result.awayMenRows.forEach(function(row){                       
                       if (row.id == data.awayMan1 || row.id == data.awayMan2 || row.id == data.awayMan3|| row.id == data.awayMan4){
                        if (row.id == data.${row.name}away${row.awayPlayers[0].replace(' ','')}){
                          var selected = " selected"
                        }
                        else {
                          var selected = ""
                        } %>
                        <option value="<%= row.id %>" <%= selected %>><%= row.first_name %> <%= row.family_name %></option>                                              
                     <% }                       
                     }) %>
                      <option value="0">No Player Home Team</option>
                      <option value="0">No Player Away Team</option> 
          </select>
          <select class="form-control playerInput" id="${row.name}away${row.awayPlayers[1].replace(' ','')}" data-player-type="away${row.awayPlayers[1].replace(' ','')}" name="${row.name}away${row.awayPlayers[1].replace(' ','')}" placeholder="Away ${row.awayPlayers[1]}">
          <% result.awayLadiesRows.forEach(function(row){                       
                       if (row.id == data.awayLady1 || row.id == data.awayLady2){
                        if (row.id == data.${row.name}away${row.awayPlayers[1].replace(' ','')}){
                          var selected = " selected"
                        }
                        else {
                          var selected = ""
                        } %>
                        <option value="<%= row.id %>" <%= selected %>><%= row.first_name %> <%= row.family_name %></option>                                              
                     <% }                       
                     }) %>
                      <option value="0">No Player Home Team</option>
                      <option value="0">No Player Away Team</option> 
          </select>
        </div>
        <div class="form-row">
          <div class="form-group step-${row.step} ${row.name} col-6">
            <label for="game${gameCount}Score">Game ${gameCount}</label>
            <div class="form-row"><div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount} home" id="Game${gameCount}homeScore" name="Game${gameCount}homeScore" placeholder="<%= data.Game${gameCount}homeScore %>"></div>
            <div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount} away" id="Game${gameCount}awayScore" name="Game${gameCount}awayScore" placeholder="<%= data.Game${gameCount}awayScore %>"></div></div>
          </div>
          <div class="form-group step-${row.step} ${row.name} col-6">
            <label for="game${gameCount+1}Score">Game ${gameCount+1}</label>
            <div class="form-row"><div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount+1} home" id="Game${gameCount+1}homeScore" name="Game${gameCount+1}homeScore" placeholder="<%= data.Game${gameCount+1}homeScore %>"></div>
            <div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount+1} away" id="Game${gameCount+1}awayScore" name="Game${gameCount+1}awayScore" placeholder="<%= data.Game${gameCount+1}awayScore %>"></div></div>
          </div>
        </div>
        
        </div>`
        }
        else {
            populatedScorecard += `<div class="modal-body step step-${row.step} ${row.name}">

        <div class="form-group step-${row.step} ${row.name}">
          <label for="home${row.name}">Home ${row.name}</label>
          <select class="form-control playerInput" id="${row.name}home${row.homePlayers[0].replace(' ','')}" data-player-type="home${row.homePlayers[0].replace(' ','')}" name="${row.name}home${row.homePlayers[0].replace(' ','')}" placeholder="Home ${row.homePlayers[0]}"></select>
          <select class="form-control playerInput" id="${row.name}home${row.homePlayers[1].replace(' ','')}" data-player-type="home${row.homePlayers[1].replace(' ','')}" name="${row.name}home${row.homePlayers[1].replace(' ','')}" placeholder="Home ${row.homePlayers[1]}"></select>
        </div>
        <div class="form-group step-${row.step} ${row.name}">
          <label for="away${row.name}">Away ${row.name}</label>
          <select class="form-control playerInput" id="${row.name}away${row.awayPlayers[0].replace(' ','')}" data-player-type="away${row.awayPlayers[0].replace(' ','')}" name="${row.name}away${row.awayPlayers[0].replace(' ','')}" placeholder="Away ${row.awayPlayers[0]}">
          </select>
          <select class="form-control playerInput" id="${row.name}away${row.awayPlayers[1].replace(' ','')}" data-player-type="away${row.awayPlayers[1].replace(' ','')}" name="${row.name}away${row.awayPlayers[1].replace(' ','')}" placeholder="Away ${row.awayPlayers[1]}">
          </select>
        </div>
        <div class="form-row">
          <div class="form-group step-${row.step} ${row.name} col-6">
            <label for="game${gameCount}Score">Game ${gameCount}</label>
            <div class="form-row"><div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount} home" id="Game${gameCount}homeScore" name="Game${gameCount}homeScore" placeholder="<%= data.Game${gameCount}homeScore %>"></div>
            <div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount} away" id="Game${gameCount}awayScore" name="Game${gameCount}awayScore" placeholder="<%= data.Game${gameCount}awayScore %>"></div></div>
          </div>
          <div class="form-group step-${row.step} ${row.name} col-6">
            <label for="game${gameCount+1}Score">Game ${gameCount+1}</label>
            <div class="form-row"><div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount+1} home" id="Game${gameCount+1}homeScore" name="Game${gameCount+1}homeScore" placeholder="<%= data.Game${gameCount+1}homeScore %>"></div>
            <div class="col-6"><input type="number" min="0" max="30" class="form-control scoreInput Game${gameCount+1} away" id="Game${gameCount+1}awayScore" name="Game${gameCount+1}awayScore" placeholder="<%= data.Game${gameCount+1}awayScore %>"></div></div>
          </div>
        </div>
        
        </div>`
        }
        
}

console.log(populatedScorecard)