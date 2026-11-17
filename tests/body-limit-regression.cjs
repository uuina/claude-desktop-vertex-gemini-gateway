'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function stopProc(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

(async () => {
  const report = { checkedAt: new Date().toISOString(), noGoogleRequests: true, bodyBytes: 0, results: [] };
  for (const [limit, mode] of [[12582912, 'headers-only'], [12582912, 'full-body'], [67108864, 'full-body'], [0, 'full-body']]) {
    const dir = fs.mkdtempSync(path.join(__dirname, 'body-limit-mock-'));
    fs.mkdirSync(path.join(dir, 'auth'));
    let hits = 0;
    const mock = http.createServer(async (req, res) => {
      for await (const chunk of req) {}
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'LOCAL_BODY_OK' }] }, finishReason: 'STOP' }] }));
    });
    const upstream = await listen(mock);
    const finder = http.createServer();
    const port = await listen(finder);
    await new Promise((resolve) => finder.close(resolve));
    const config = `config-version: 8\nserver:\n  host: "127.0.0.1"\n  port: ${port}\n  max-request-body-bytes: ${limit}\n  commercial-mode: true\nmanagement:\n  disable-control-panel: true\n  disable-auto-update-panel: true\naccess:\n  api-keys: ["local-body-fixture"]\nrouting:\n  retry:\n    request-retry: 0\nrequests:\n  nonstream-keepalive-interval: 0\napi-keys:\n  vertex:\n    - name: local-test\n      base-url: "http://127.0.0.1:${upstream}"\n      models:\n        - name: "gemini-4-carbon"\n          alias: "gemini-4-carbon"\n      keys:\n        - api-key: "local-fake"\noauth:\n  auth-dir: ${JSON.stringify(path.join(dir, 'auth').replaceAll('\\', '/'))}\n`;
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, config);
    const proc = spawn(path.join(root, 'gateway-8.0.66/cli-proxy-api.exe'), ['-config', file, '-local-model'], { windowsHide: true, cwd: dir, stdio: 'ignore' });
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer local-body-fixture' }, signal: AbortSignal.timeout(500) });
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(ready);
      const body = JSON.stringify({ model: 'gemini-4-carbon', max_tokens: 10, stream: false, messages: [{ role: 'user', content: 'x'.repeat(13 * 1024 * 1024) }] });
      report.bodyBytes = Buffer.byteLength(body);
      const start = Date.now();
      const record = await new Promise((resolve) => {
        const result = { limit, mode, status: null, errorCode: null };
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          result.elapsedMs = Date.now() - start;
          result.upstreamHits = hits;
          resolve(result);
        };
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: { authorization: 'Bearer local-body-fixture', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
        }, (res) => {
          result.status = res.statusCode;
          res.resume();
          res.on('end', done);
          res.on('error', (error) => {
            result.errorCode = error.code;
            done();
          });
        });
        req.setTimeout(15000, () => req.destroy(Error('fixture timeout')));
        req.on('error', (error) => {
          result.errorCode = error.code || error.name;
          done();
        });
        if (mode === 'headers-only') req.end();
        else req.end(body);
      });
      report.results.push(record);
      fs.writeFileSync(path.join(__dirname, 'body-limit-regression.json'), JSON.stringify(report, null, 2));
      if (limit === 12582912 && mode === 'full-body') {
        assert(record.status === 413 || ['ECONNRESET', 'EPIPE'].includes(record.errorCode), 'Old limit must reject without forwarding');
      } else {
        assert.equal(record.status, limit === 12582912 ? 413 : 200);
      }
      assert.equal(record.upstreamHits, limit === 12582912 ? 0 : 1);
    } finally {
      await stopProc(proc);
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  report.passed = true;
  fs.writeFileSync(path.join(__dirname, 'body-limit-regression.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
