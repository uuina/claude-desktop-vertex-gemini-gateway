'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const keys = readJson(path.join(root, 'private/keys.json'));
const policy = readJson(path.join(root, 'guard-config.json'));
if (!policy.billingCreditPolicyAccepted || Date.now() >= Date.parse(policy.cutoffUtc)) {
  throw Error('Model diagnostic authorization is expired');
}

const report = { startedAt: new Date().toISOString(), syntheticOnly: true, retries: 0, desktopUiTest: false, requests: [] };
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(__dirname, 'live-smoke-' + stamp + '.json');
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));

async function send(port, payload, label) {
  const record = { label, port, model: payload.model, requestBytes: Buffer.byteLength(JSON.stringify(payload)), startedAt: new Date().toISOString() };
  report.requests.push(record);
  save();
  const start = Date.now();
  let raw = '';
  let firstByteMs = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + keys.backendKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-protected-thinking-level': 'low' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000)
    });
    record.httpStatus = response.status;
    for await (const chunk of response.body) {
      if (firstByteMs === null) firstByteMs = Date.now() - start;
      raw += Buffer.from(chunk).toString();
      if (raw.length > 2 * 1024 * 1024) throw Error('Unexpected response size');
    }
    const events = raw.split('\n').filter((line) => line.startsWith('data: ')).flatMap((line) => {
      try {
        return [JSON.parse(line.slice(6))];
      } catch {
        return [];
      }
    });
    record.firstByteMs = firstByteMs;
    record.elapsedMs = Date.now() - start;
    record.eventTypes = events.map((event) => event.type);
    record.usage = events.filter((event) => event.usage || event.message?.usage).map((event) => event.usage || event.message.usage);
    record.errorTypes = events.filter((event) => event.type === 'error').map((event) => event.error?.type || 'unknown');
    record.errorClasses = ['MALFORMED_FUNCTION_CALL', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL_ERROR', 'unexpected EOF'].filter((value) => raw.includes(value));
    record.complete = events.some((event) => event.type === 'message_stop');
    save();
    assert.equal(response.status, 200, label + ' HTTP status');
    assert.equal(record.errorTypes.length, 0, label + ' error events');
    assert(record.complete, label + ' terminal event');
    return events;
  } catch (error) {
    record.elapsedMs = Date.now() - start;
    record.failure = error.name === 'AssertionError' ? error.message : error.name;
    record.usageUnknown = !record.usage;
    save();
    throw error;
  }
}

(async () => {
  try {
    const marker = 'PATCH_SMOKE_OK';
    const tools = [{ name: 'audit_echo', description: 'Echo a constant for a connectivity test.', input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }];
    const messages = [{ role: 'user', content: `Connectivity test only. Call audit_echo once with value ${marker}. Do no other work.` }];
    const common = { model: 'carbon-us/claude-opus-5', max_tokens: 128, stream: true, output_config: { effort: 'low' }, tools, messages };
    const events = await send(18432, { ...common, tool_choice: { type: 'tool', name: 'audit_echo' } }, 'carbon-tool-call');
    const tool = events.find((event) => event.content_block?.type === 'tool_use');
    assert(tool, 'Tool call missing');
    const fragments = events.filter((event) => event.index === tool.index && event.delta?.type === 'input_json_delta').map((event) => event.delta.partial_json).join('');
    const input = fragments ? JSON.parse(fragments) : tool.content_block.input;
    assert.equal(input.value, marker);
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: tool.content_block.id, name: 'audit_echo', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.content_block.id, content: marker }] }
    );
    const followup = await send(18432, { ...common, tool_choice: { type: 'none' } }, 'carbon-tool-result');
    assert(followup.filter((event) => event.delta?.type === 'text_delta').map((event) => event.delta.text).join('').includes(marker), 'Echo result missing');
    const argon = await send(18432, { model: 'gemini-4-argon', max_tokens: 64, stream: true, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with exactly ARGON_PATCH_OK and nothing else.' }] }, 'argon-text');
    assert(argon.filter((event) => event.delta?.type === 'text_delta').map((event) => event.delta.text).join('').includes('ARGON_PATCH_OK'), 'Argon response missing');
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.name === 'AssertionError' ? error.message : error.name;
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({
    path: output,
    passed: report.passed,
    requests: report.requests.map(({ label, httpStatus, elapsedMs, complete, errorClasses, usage }) => ({ label, httpStatus, elapsedMs, complete, errorClasses, usage })),
    failure: report.failure
  }));
  if (!report.passed) process.exitCode = 1;
})();
