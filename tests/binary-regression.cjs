'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');

async function stopProc(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

(async () => {
  const results = [];
  const injected = 200;
  for (const scenario of ['malformed', 'partial-malformed', 'partial-tool-malformed', 'normal-tool', 'real-401', 'real-429', 'real-502']) {
    for (const stream of [false, true]) {
      const dir = fs.mkdtempSync(path.join(__dirname, 'binary-regression-mock-'));
      fs.mkdirSync(path.join(dir, 'auth'));
      let hits = 0;
      const mock = http.createServer(async (q, r) => {
        for await (const chunk of q) {}
        hits++;
        if (hits === 1) {
          if (scenario.startsWith('real-')) {
            const code = Number(scenario.slice(5));
            r.writeHead(code, { 'content-type': 'application/json' });
            return r.end(JSON.stringify({ error: { code, message: 'OFFLINE_UPSTREAM_ERROR' } }));
          }
          const normal = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'offline_tool', args: { x: 1 } } }] }, finishReason: 'STOP' }] };
          const malformed = { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'SENSITIVE_FIXTURE_DO_NOT_LOG' }] };
          let item = scenario === 'normal-tool' ? normal : malformed;
          if (!stream && scenario === 'partial-malformed') {
            item = { candidates: [{ ...normal.candidates[0], finishReason: 'MALFORMED_FUNCTION_CALL' }] };
          }
          r.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
          if (stream && scenario === 'partial-tool-malformed') {
            r.write('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'offline_tool', args: { x: 1 } } }] } }] }) + '\n\n');
          }
          if (stream && scenario === 'partial-malformed') {
            r.write('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OFFLINE_PARTIAL' }] } }] }) + '\n\n');
          }
          return r.end(stream ? 'data: ' + JSON.stringify(item) + '\n\n' : JSON.stringify(item));
        }
        const ok = { candidates: [{ content: { role: 'model', parts: [{ text: 'OFFLINE_OK' }] }, finishReason: 'STOP' }] };
        r.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
        r.end(stream ? 'data: ' + JSON.stringify(ok) + '\n\n' : JSON.stringify(ok));
      });
      mock.listen(0, '127.0.0.1');
      await once(mock, 'listening');
      const finder = http.createServer();
      finder.listen(0, '127.0.0.1');
      await once(finder, 'listening');
      const port = finder.address().port;
      await new Promise((r) => finder.close(r));
      let config = `config-version: 8\nserver:\n  host: "127.0.0.1"\n  port: ${port}\nmanagement:\n  secret-key: ""\n  disable-control-panel: true\n  disable-auto-update-panel: true\naccess:\n  api-keys: ["offline-only-client"]\nrouting:\n  force-model-prefix: true\n  retry:\n    request-retry: 2\n    max-retry-credentials: 2\n    max-retry-interval: 0\nrequests:\n  streaming:\n    bootstrap-retries: 2\napi-keys:\n  vertex:\n    - name: offline-carbon\n      prefix: "carbon-us"\n      base-url: "http://127.0.0.1:${mock.address().port}"\n      models:\n        - name: "gemini-4-carbon"\n          alias: "gemini-4-carbon"\n      keys:\n        - api-key: "offline-only-fake-key"\n        - api-key: "offline-only-fake-key-2"\noauth:\n  auth-dir: ${JSON.stringify(path.join(dir, 'auth').replaceAll('\\', '/'))}\n`;
      if (!scenario.includes('malformed')) {
        config = config.replace('        - api-key: "offline-only-fake-key-2"\n', '').replace('request-retry: 2', 'request-retry: 0');
      }
      const file = path.join(dir, 'config.yaml');
      fs.writeFileSync(file, config);
      const proc = spawn(process.env.CPA_TEST_EXE || path.join(root, 'gateway-8.0.66/cli-proxy-api.exe'), ['-config', file, '-local-model'], { windowsHide: true, cwd: dir, stdio: 'ignore' });
      try {
        let ready = false;
        for (let n = 0; n < 60; n++) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer offline-only-client' }, signal: AbortSignal.timeout(500) });
            if (r.ok) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!ready) throw Error('isolated CPA startup failed');
        for (const waitMs of [0, 0]) {
          if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
          const before = hits;
          const started = Date.now();
          const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
            method: 'POST',
            headers: { authorization: 'Bearer offline-only-client', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'carbon-us/gemini-4-carbon',
              max_tokens: 10,
              stream,
              tools: [{ name: 'offline_tool', description: 'fixture', input_schema: { type: 'object', properties: { x: { type: 'integer' } } } }],
              messages: [{ role: 'user', content: 'OFFLINE_FIXTURE' }]
            }),
            signal: AbortSignal.timeout(10000)
          });
          const body = await r.text();
          const record = { scenario, stream, injected, waitMs, status: r.status, elapsedMs: Date.now() - started, upstreamHitsBefore: before, upstreamHitsAfter: hits, retryAfter: r.headers.get('retry-after'), body: body.slice(0, 2000) };
          results.push(record);
          console.log(JSON.stringify(record));
        }
      } finally {
        await stopProc(proc);
        mock.closeAllConnections();
        await new Promise((r) => mock.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  fs.writeFileSync(path.join(__dirname, process.env.CPA_RESULT_FILE || 'binary-regression-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), noRealCredentials: true, noGoogleRequests: true, results }, null, 2));
  if (process.env.CPA_TEST_ASSERT !== '0') {
    for (let i = 0; i < results.length; i += 2) {
      const a = results[i];
      const b = results[i + 1];
      if (a.scenario === 'partial-tool-malformed' && a.stream) {
        if (a.status !== 200 || !a.body.includes('"stop_reason":"tool_use"') || !a.body.includes('event: message_stop') || a.body.includes('event: error')) {
          throw Error('partial-tool-malformed stream did not finalize prior tool_use cleanly');
        }
        if (b.status !== 200 || b.upstreamHitsAfter !== 2) {
          throw Error('malformed poisoned credential');
        }
      } else if (a.scenario.includes('malformed')) {
        if (!a.body.includes('MALFORMED_FUNCTION_CALL') || a.body.includes('"stop_reason":"tool_use"') || a.body.includes('event: message_stop')) {
          throw Error('malformed falsely completed ' + a.scenario);
        }
        if (b.status !== 200 || b.upstreamHitsAfter !== 2) {
          throw Error('malformed poisoned credential');
        }
      }
      if (a.scenario === 'normal-tool' && (a.status !== 200 || !a.body.includes('tool_use') || b.status !== 200)) {
        throw Error('normal tool regression');
      }
      if (a.scenario.startsWith('real-')) {
        if (a.status !== Number(a.scenario.slice(5)) || b.upstreamHitsAfter !== 1 || !b.retryAfter) {
          throw Error('protection regression ' + a.scenario);
        }
      }
      if (a.upstreamHitsAfter !== 1) {
        throw Error('unexpected replay');
      }
    }
    console.log('ALL_ASSERTIONS_PASSED');
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
