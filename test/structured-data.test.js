// utils/structuredData.js: the SportsEvent and breadcrumbs the event pages emit.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const SD = require('../utils/structuredData');

const F = {
  id: 6171, date: new Date('2026-09-01T23:00:00Z'), homeTeam: 'Hyde A', awayTeam: "St Mary's A",
  divisionName: 'Division 1', startTime: '20:00:00', endTime: '22:00:00', status: 'outstanding',
  venueName: 'Hyde Leisure Centre', venueAddress: 'Hyde Leisure Centre, Walker Lane, Hyde, SK14 5PL. Park round the back.',
  venueLink: 'https://maps.example.test', Lat: 53.45, Lng: -2.08,
};

describe('sportsEvent', () => {
  const ev = SD.sportsEvent(F);

  it('uses real schema.org properties for the teams and the address', () => {
    assert.deepStrictEqual(ev.homeTeam, { '@type': 'SportsTeam', name: 'Hyde A' });
    assert.deepStrictEqual(ev.awayTeam, { '@type': 'SportsTeam', name: "St Mary's A" });
    assert.deepStrictEqual(ev.location.address, { '@type': 'PostalAddress', streetAddress: 'Hyde Leisure Centre, Walker Lane',
      addressLocality: 'Hyde', postalCode: 'SK14 5PL', addressCountry: 'GB' });
    assert.deepStrictEqual(ev.location.geo, { '@type': 'GeoCoordinates', latitude: 53.45, longitude: -2.08 });
    assert.ok(!('competitor' in ev) && !('Lat' in ev.location));
  });

  it('dates it on the UK day with London\'s offset, not the server\'s', () => {
    assert.strictEqual(ev.startDate, '2026-09-02T20:00:00+01:00');
    assert.strictEqual(ev.endDate, '2026-09-02T22:00:00+01:00');
    assert.strictEqual(SD.sportsEvent({ ...F, date: new Date('2027-01-05T00:00:00Z') }).startDate, '2027-01-05T20:00:00Z');
  });

  it('follows the fixture\'s status', () => {
    assert.strictEqual(SD.sportsEvent({ ...F, status: 'rearranging' }).eventStatus, 'https://schema.org/EventPostponed');
    assert.strictEqual(SD.sportsEvent({ ...F, status: 'void' }).eventStatus, 'https://schema.org/EventCancelled');
  });

  it('drops coordinates outside the league', () => {
    assert.strictEqual(SD.geoOf(54.45, -2.08), null);
    assert.strictEqual(SD.geoOf(0, 0), null);
  });

  it('serialises safely: an apostrophe stays one, and </script> cannot close the block', () => {
    const out = SD.jsonLd(SD.sportsEvent({ ...F, awayTeam: "St Mary's </script>" }));
    assert.match(out, /St Mary's \\u003c\/script>/);
    assert.doesNotMatch(out, /&#39;|<\/script>/);
    JSON.parse(out);
  });
});

describe('breadcrumbs', () => {
  it('numbers the trail and makes every link absolute', () => {
    const b = SD.breadcrumbs([{ name: 'Home', path: '/' }, { name: 'Hyde A vs Mellor A', path: '/event/1/x' }]);
    assert.deepStrictEqual(b.itemListElement.map(i => [i.position, i.name]), [[1, 'Home'], [2, 'Hyde A vs Mellor A']]);
    assert.match(b.itemListElement[1].item, /^https:\/\/.+\/event\/1\/x$/);
  });
});
