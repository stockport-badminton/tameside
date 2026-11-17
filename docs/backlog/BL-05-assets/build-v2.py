import html
ex = {
 'home':'Hyde A','away':'G.H.A.P B','div':'1','venue':'Hyde Leisure Centre','date':'12/11/26',
 'H':{'ladies':['Sarah Kemp','Priya Shah'],'mixed':[['Tom Ellis',1,'A'],['Dan Moss',2,'A'],['Rob Kerr',2,'B'],['Sam Pike',1,'B']]},
 'A':{'ladies':['Emma Lowe','Kate Ryan'],'mixed':[['Mark Hale',1,'A'],['Joe Finch',2,'B'],['Ian Webb',1,'A'],['Lee Cobb',2,'B']]},
}
events = [
 ('Men','A v A',[[21,17],[19,21]]),('Ladies','',[[21,12],[21,15]]),('Men','B v B',[[15,21],[21,23]]),
 ('Mixed','1st',[[21,18],[21,19]]),('Mixed','2nd',[[18,21],[21,16]]),('Mixed','3rd',[[21,9],[21,14]]),
 ('Mixed','4th',[[22,24],[21,19]]),('Men','A v B',[[21,16],[30,29]]),('Men','B v A',[[12,21],[17,21]]),
]
def hw(v, fill): return f'<span class="hw">{html.escape(str(v))}</span>' if fill else ''
def side_rows(key, label, fill):
    d = ex[key]; rows = [f'<td class="sidehead" colspan="4">{label} TEAM <span>mixed pairs, strongest first</span></td>']
    for i,(man,l,p) in enumerate(d['mixed']):
        ab = f'<span class="wbox">{hw(p, fill)}</span>'
        rows.append(f'<td class="pn" rowspan="2">{i+1}</td><td class="ml">M</td><td class="nm">{hw(man,fill)}</td><td class="ab" rowspan="2">{ab}</td>')
        rows.append(f'<td class="ml">L</td><td class="nm lady">{hw(d["ladies"][l-1],fill)}</td>')
    return rows
def card(fill):
    left = side_rows('H','HOME',fill) + side_rows('A','AWAY',fill)
    right = []; tot=[0,0]
    for name,sub,s in events:
        won=[0,0]
        for g in s: won[0 if g[0]>g[1] else 1]+=1
        tot[0]+=won[0]; tot[1]+=won[1]
        for gi in range(2):
            r = ''
            if gi==0: r += f'<td class="ev" rowspan="2"><b>{name}</b>{"<small>"+sub+"</small>" if sub else ""}</td>'
            r += f'<td class="pt">{hw(s[gi][0],fill)}</td><td class="pt">{hw(s[gi][1],fill)}</td>'
            if gi==0: r += f'<td class="gw" rowspan="2">{hw(won[0],fill)}</td><td class="gw" rowspan="2">{hw(won[1],fill)}</td>'
            right.append(r)
    body = ''
    for i in range(18):
        cls = []
        if i % 2 == 1 and i not in (9,): pass
        # event boundaries every 2 rows on right; pair boundaries on left start at rows 1,3,5,7 and 10,12,14,16
        body += f'<tr class="{"evtop" if i%2==0 else ""} {"pairtop" if i in (1,3,5,7,10,12,14,16) else ""} {"headrow" if i in (0,9) else ""}">{left[i]}<td class="gap"></td>{right[i]}</tr>'
    t = '' if not fill else str(tot[0]); u = '' if not fill else str(tot[1])
    return f'''<div class="card">
  <div class="title"><h2>Tameside Badminton League</h2><div class="sub">Match Scorecard</div></div>
  <div class="box row2"><span class="k">Date</span><span class="v">{hw(ex["date"],fill)}</span><span class="k">Division</span><span class="v short">{hw(ex["div"],fill)}</span></div>
  <div class="box row3"><span class="k">Home</span><span class="v">{hw(ex["home"],fill)}</span><span class="k">v Away</span><span class="v">{hw(ex["away"],fill)}</span></div>
  <div class="box row1"><span class="k">Played at</span><span class="v">{hw(ex["venue"],fill)}</span></div>
  <table class="grid">
    <colgroup><col class="c-pn"><col class="c-ml"><col class="c-nm"><col class="c-ab"><col class="c-gap"><col class="c-ev"><col class="c-pt"><col class="c-pt"><col class="c-gw"><col class="c-gw"></colgroup>
    <thead>
      <tr><th colspan="3" rowspan="2" class="lh">Team sheet</th><th rowspan="2" class="lh abh">Men's<br>pair<br>A/B</th><td class="gap"></td><th rowspan="2">Event</th><th colspan="2">Points</th><th colspan="2">Games</th></tr>
      <tr><td class="gap"></td><th>H</th><th>A</th><th>H</th><th>A</th></tr>
    </thead>
    <tbody>{body}</tbody>
    <tfoot><tr><td colspan="4" class="note">Each lady plays in two mixed pairs. Write A or B in each man's box: two A, two B.</td><td class="gap"></td><td colspan="3" class="totl">Totals</td><td class="gw tot">{hw(t,fill)}</td><td class="gw tot">{hw(u,fill)}</td></tr></tfoot>
  </table>
  <div class="box sig"><span class="k">Captains' signatures</span><span class="k">Home</span><span class="v"></span><span class="k">Away</span><span class="v"></span></div>
</div>'''
derive = ''
def plist(key, i):
    d=ex[key]; name,sub,_=events[i]
    if name=='Ladies': return ' & '.join(d['ladies'])
    if name=='Mixed':
        m=d['mixed'][int(sub[0])-1]; return f'{m[0]} & {d["ladies"][m[1]-1]}'
    want = sub.split(' v ')[0 if key=='H' else 1]
    return ' & '.join(m[0] for m in d['mixed'] if m[2]==want)
for i,(n,s,_) in enumerate(events):
    derive += f'<tr><td>{n} {s}</td><td>{plist("H",i)}</td><td>{plist("A",i)}</td></tr>'
explain = f'''<div class="explain">
  <h1>Proposed scorecard layout</h1>
  <p>On the current card each player's name is written three times, once in each event they play. On this card the captain writes the team once, as the four mixed pairs. The results grid needs scores only.</p>
  <h2>How the captain fills it in</h2>
  <ul>
    <li>Write the four mixed pairs, man and lady, strongest pair first. That is the only ordering rule. Each lady appears in two pairs.</li>
    <li>Write A or B in the box next to each man to say which men's pair he plays in. Two men are A and two are B.</li>
    <li>Every other event follows from that. The two ladies play the opposition's two ladies, and each men's pair plays both of the other side's men's pairs.</li>
  </ul>
  <h2>What the example works out to</h2>
  <table class="derive"><thead><tr><th>Event</th><th>Home</th><th>Away</th></tr></thead><tbody>{derive}</tbody></table>
  <h2>Other changes</h2>
  <ul>
    <li>No "register additional players" section.</li>
    <li>Each event's two games are on the rows beside it, the same as on the Stockport card.</li>
    <li>Both captains sign. Events are played in the same order as now, and it still prints two cards to an A4 sheet.</li>
  </ul>
</div>'''
css = open('v2.css').read()
out = f'''<!doctype html><html><head><meta charset="utf-8"><title>Tameside Scorecard Proposal v2</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Caveat:wght@500;600&display=swap">
<style>{css}</style></head><body>
<section class="page"><div class="slot">{explain}</div><div class="slot">{card(True)}</div></section>
<section class="page"><div class="slot">{card(False)}</div><div class="slot">{card(False)}</div></section>
</body></html>'''
open('scorecard-print-v2.html','w').write(out)
