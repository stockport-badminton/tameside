// /rules renders the league rules from Contentful. A Contentful failure used to be
// `.catch(console.error)`: logged, never answered, so the request hung until the platform's
// 60 s cut. It goes to the central error handler now.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');
const staticPages = require('../../controllers/staticPagesController');

afterEach(() => mock.restoreAll());

describe('GET /rules', () => {
  it('answers with an error page when Contentful fails, rather than hanging', { timeout: 5000 }, async () => {
    mock.method(staticPages._contentfulClient, 'getEntry', async () => { throw new Error('Contentful is down'); });
    mock.method(console, 'error', () => {});
    const res = await request(app).get('/rules');
    assert.strictEqual(res.status, 500);
  });

  it('renders the rules Contentful returns', async () => {
    mock.method(staticPages._contentfulClient, 'getEntry', async () => ({
      fields: { richTextField: { nodeType: 'document', data: {}, content: [
        { nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value: 'Rule one.', marks: [], data: {} }] },
      ] } },
    }));
    const res = await request(app).get('/rules');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Rule one\./);
    assert.doesNotMatch(res.text, /maps\/embed/);
  });
});
