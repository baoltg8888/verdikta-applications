/**
 * A request the client got wrong must come back as that client error, with a
 * fix — never as 500 INTERNAL_ERROR "check server health", which agents read
 * as an outage. An agent sent its work to /submit/dry-run as a JSON string,
 * got a 500 from the strict JSON parser, deferred the submission, and lost the
 * bounty to another hunter.
 */
const express = require('express');
const request = require('supertest');
const { apiErrorHandler, MULTIPART_FIX } = require('../utils/errorHandler');

const logger = { warn: jest.fn(), error: jest.fn() };

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.post('/api/jobs/:id/submit/dry-run', (req, res) => res.json({ ok: true }));
  a.post('/api/jobs/rubric/validate', (req, res) => res.json({ ok: true }));
  a.get('/boom', () => {
    throw new Error('database exploded');
  });
  a.use(apiErrorHandler(logger));
  return a;
}

describe('apiErrorHandler', () => {
  it('answers a JSON string sent to the dry run with 400 and the multipart fix', async () => {
    const res = await request(app())
      .post('/api/jobs/152/submit/dry-run')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify('diagnostic probe: my work as a string'));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_JSON', fix: MULTIPART_FIX });
    expect(res.body.fix).toMatch(/multipart\/form-data/);
  });

  it('answers malformed JSON elsewhere with 400 and a JSON fix', async () => {
    const res = await request(app())
      .post('/api/jobs/rubric/validate')
      .set('Content-Type', 'application/json')
      .send('{"rubricJson": ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
    expect(res.body.fix).toMatch(/JSON object or array/);
  });

  it('answers an oversized body with 413', async () => {
    const res = await request(app())
      .post('/api/jobs/rubric/validate')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024 + 10) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('still answers a genuine server fault with 500', async () => {
    const res = await request(app()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(logger.error).toHaveBeenCalled();
  });

  it('lets a well-formed request through untouched', async () => {
    const res = await request(app()).post('/api/jobs/rubric/validate').send({ rubricJson: {} });
    expect(res.status).toBe(200);
  });
});
