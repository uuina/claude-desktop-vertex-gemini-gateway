'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  const config = JSON.parse(input);
  if (!config.pipe.startsWith('\\\\.\\pipe\\verge-mihomo-')) {
    throw Error('Unexpected local controller');
  }
  function get(endpoint) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: config.pipe,
        path: endpoint,
        method: 'GET',
        headers: config.secret ? { authorization: 'Bearer ' + config.secret } : {}
      }, (res) => {
        let raw = '';
        res.on('data', (data) => {
          raw += data;
        });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw Error('Controller HTTP ' + res.statusCode);
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.setTimeout(5000, () => req.destroy(Error('Controller timeout')));
      req.on('error', reject);
      req.end();
    });
  }
  try {
    const configs = await get('/configs');
    const proxies = (await get('/proxies')).proxies;
    const groups = Object.fromEntries(Object.entries(proxies).filter(([, p]) => p.now).map(([name, p]) => [name, { type: p.type, now: p.now }]));
    const connections = (await get('/connections')).connections
      .filter((c) => /googleapis|aiplatform/.test(c.metadata?.host || ''))
      .map((c) => ({ host: c.metadata.host, chains: c.chains, rule: c.rule }));
    const result = { checkedAt: new Date().toISOString(), mode: configs.mode, groups, connections };
    fs.writeFileSync(path.join(__dirname, 'live-proxy-metadata.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
});
