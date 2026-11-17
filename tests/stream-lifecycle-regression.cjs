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
  const results = [];
  for (const scenario of ['partial-disconnect', 'silent-130-seconds']) {
    const dir = fs.mkdtempSync(path.join(__dirname, 'stream-lifecycle-mock-'));
    fs.mkdirSync(path.join(dir, 'auth'));
    let hits = 0;
    let delayTimer;
    const mock = http.createServer(async (req, res) => {
      for await (const chunk of req) {}
      hits++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'LOCAL_BEGIN' }] } }] }) + '\n\n');
      delayTimer = setTimeout(() => {
        if (scenario === 'partial-disconnect') {
          res.destroy();
          return;
        }
        res.end('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: ' LOCAL_END' }] }, finishReason: 'STOP' }] }) + '\n\n');
      }, scenario === 'partial-disconnect' ? 200 : 130000);
    });
    const upstream = await listen(mock);
    const finder = http.createServer();
    const port = await listen(finder);
    await new Promise((resolve) => finder.close(resolve));
    const config = `config-version: 8\ndisable-cooling: true\nserver:\n  host: "127.0.0.1"\n  port: ${port}\n  commercial-mode: true\nmanagement:\n  disable-control-panel: true\n  disable-auto-update-panel: true\naccess:\n  api-keys: ["local-stream-fixture"]\nrouting:\n  transient-error-cooldown-seconds: -1\n  retry:\n    request-retry: 0\n    max-retry-credentials: 1\nrequests:\n  nonstream-keepalive-interval: 0\n  streaming:\n    keepalive-seconds: 5\n    bootstrap-retries: 0\napi-keys:\n  vertex:\n    - name: local-test\n      base-url: "http://127.0.0.1:${upstream}"\n      models:\n        - name: "gemini-4-carbon"\n          alias: "gemini-4-carbon"\n      keys:\n        - api-key: "local-fake"\noauth:\n  auth-dir: ${JSON.stringify(path.join(dir, 'auth').replaceAll('\\', '/'))}\n`;
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, config);
    const proc = spawn(path.join(root, 'gateway-8.0.66/cli-proxy-api.exe'), ['-config', file, '-local-model'], { windowsHide: true, cwd: dir, stdio: 'ignore' });
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer local-stream-fixture' }, signal: AbortSignal.timeout(500) });
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(ready);
      const start = Date.now();
      const times = [];
      let raw = '';
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer local-stream-fixture', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-4-carbon', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'LOCAL_STREAM_FIXTURE' }] }),
        signal: AbortSignal.timeout(160000)
      });
      for await (const chunk of response.body) {
        times.push(Date.now() - start);
        raw += Buffer.from(chunk).toString();
      }
      const result = {
        scenario,
        status: response.status,
        elapsedMs: Date.now() - start,
        upstreamHits: hits,
        firstByteMs: times[0],
        maxChunkGapMs: Math.max(0, ...times.slice(1).map((value, index) => value - times[index])),
        chunks: times.length,
        errorEvent: raw.includes('event: error'),
        completed: raw.includes('event: message_stop'),
        hasFinalText: raw.includes('LOCAL_END')
      };
      results.push(result);
      fs.writeFileSync(path.join(__dirname, 'stream-lifecycle-regression.json'), JSON.stringify({ noGoogleRequests: true, results }, null, 2));
      console.log(JSON.stringify(result));
      assert.equal(hits, 1, 'No internal replay');
      if (scenario === 'partial-disconnect') {
        assert(result.errorEvent, 'Disconnect must produce error');
        assert(!result.completed, 'Disconnect must not complete successfully');
      } else {
        assert(result.elapsedMs >= 130000);
        assert(result.completed && result.hasFinalText && !result.errorEvent);
        assert(result.maxChunkGapMs < 10000, '5-second keepalive must cover silent upstream');
      }
    } finally {
      clearTimeout(delayTimer);
      await stopProc(proc);
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(__dirname, 'stream-lifecycle-regression.json'), JSON.stringify({ checkedAt: new Date().toISOString(), noGoogleRequests: true, passed: true, results }, null, 2));
  console.log('STREAM_LIFECYCLE_ASSERTIONS_PASSED');
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
