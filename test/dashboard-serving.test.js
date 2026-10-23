'use strict';

// The dashboard is served by the API server itself (src/server.js), not only
// by the optional frontend.js process. That same-origin wiring is what makes
// the admin UI work from ANY device — a phone, a second office machine,
// Termux via a LAN address — because there is no cross-origin request left to
// refuse. These tests pin the three pieces of that: the root URL answers with
// the dashboard shell, /config.js points the SPA at its own origin (the
// committed fallback file must never win), and the API reference index still
// exists at its new /api-docs path.

require('./helpers/isolate');

const test = require('node:test');
const assert = require('node:assert/strict');

/** Boot the real app on an ephemeral port, hand `fn` its base URL, close it. */
async function withServer(fn) {
  const http = require('node:http');
  const app = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(url, headers = {}) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'] || '',
            cache: res.headers['cache-control'] || '',
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      })
      .on('error', reject);
  });
}

test('the root URL serves the dashboard shell', async () => {
  await withServer(async (base) => {
    const res = await get(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/html/);
    assert.match(res.body, /<script src="\/config\.js"><\/script>/, 'the SPA loads config.js');
    const configAt = res.body.indexOf('/config.js');
    const appAt = res.body.indexOf('/app.js');
    assert.ok(configAt > -1 && appAt > -1 && configAt < appAt,
      'config.js loads before app.js, so API_BASE exists when app.js reads it');
    assert.match(res.cache, /no-cache/, 'the dashboard must never heuristically cache across deploys');
  });
});

test('/config.js points the dashboard at its own origin — same origin, no CORS', async () => {
  await withServer(async (base) => {
    const res = await get(`${base}/config.js`);
    assert.equal(res.status, 200);
    assert.match(res.type, /javascript/);
    assert.match(res.body, /window\.location\.origin/,
      'API_BASE follows wherever the page was opened from — the server that served it is the API');
    assert.doesNotMatch(res.body, /localhost:3000/,
      'the committed fallback must not win over the dynamic route');
  });
});

test('the API reference index lives at /api-docs (the root belongs to the dashboard)', async () => {
  await withServer(async (base) => {
    const res = await get(`${base}/api-docs`);
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/html/);
    assert.match(res.body, /API/, 'the endpoint reference page rendered');
    const health = await get(`${base}/health`);
    assert.equal(health.status, 200, '/health is untouched by the static middleware');
    assert.doesNotMatch(health.body, /<html/i, 'health stays JSON');
  });
});

/** A browser preflight, as sent before a cross-origin POST with JSON + token. */
function preflight(base, origin) {
  const http = require('node:http');
  const url = new URL(`${base}/api/exams`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, allow: res.headers['access-control-allow-origin'] }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// The shipped dashboard's origin MUST stay allow-listed in source. It was
// once carried by CORS_ORIGIN alone, was removed as "unneeded" in an env
// audit, and every dashboard action — creating an exam above all — died as
// an opaque "Failed to fetch". This pins the regression directly.
test('the Vercel dashboard origin passes the preflight with no env vars set', async () => {
  await withServer(async (base) => {
    const res = await preflight(base, 'https://what-exam.vercel.app');
    assert.equal(res.status, 204);
    assert.equal(res.allow, 'https://what-exam.vercel.app',
      'the shipped dashboard must be allowed without CORS_ORIGIN being set');
  });
});

test('a stranger origin is still refused — the default is not a wildcard', async () => {
  await withServer(async (base) => {
    const res = await preflight(base, 'https://someone-else.example');
    assert.equal(res.status, 204, 'the OPTIONS answer itself always succeeds');
    assert.equal(res.allow, undefined, 'no allow header: the browser will block this origin');
  });
});

test('loopback origins keep working (the local dashboard)', async () => {
  await withServer(async (base) => {
    const res = await preflight(base, 'http://localhost:8080');
    assert.equal(res.allow, 'http://localhost:8080');
  });
});
