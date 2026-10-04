import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkPort, warnIfPortTaken } from '../src/port.mjs';

// Invariant: every canonical port 1-65535 is accepted and returned as a number.
test('checkPort accepts canonical ports as numbers', () => {
  for (const [raw, n] of [['1', 1], ['8787', 8787], ['65535', 65535]]) assert.strictEqual(checkPort(raw), n);
});

// Invariant: only canonical decimal passes, so NSIS's string compare equals an
// integer compare, and a stray quote from the switch parser fails loudly.
test('checkPort refuses anything but canonical decimal 1-65535', () => {
  for (const raw of ['', '0', '65536', '99999', '080', '+80', '-1', ' 80', '80 ', '8a', '1e3', '0x50', '8787.0', '1"', undefined]) {
    assert.throws(() => checkPort(raw), /whole number from 1 to 65535/, JSON.stringify(raw));
  }
});

// Invariant: a port really in use logs a warning naming it and EADDRINUSE,
// returns true and does not throw.
test('warnIfPortTaken warns about a port a real server holds', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen({ port: 0, host: '127.0.0.1' }, r));
  try {
    const { port } = srv.address();
    const lines = [];
    assert.equal(await warnIfPortTaken(port, { log: (m) => lines.push(m) }), true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`WARNING ${port} .*EADDRINUSE`));
  } finally { await new Promise((r) => srv.close(r)); }
});

// Invariant: a free port logs without a warning; EACCES points at the reserved
// range; an unknown code is warned about, never thrown.
test('warnIfPortTaken reports free, EACCES and unknown results', async () => {
  const run = async (listen) => {
    const lines = [];
    const taken = await warnIfPortTaken(9000, { log: (m) => lines.push(m), listen });
    return { taken, text: lines.join('\n') };
  };
  const free = await run(async () => null);
  assert.equal(free.taken, false);
  assert.equal(free.text, 'port: 9000');
  const acc = await run(async () => 'EACCES');
  assert.equal(acc.taken, true);
  assert.match(acc.text, /excludedportrange/);
  const odd = await run(async () => 'EOTHER');
  assert.equal(odd.taken, true);
  assert.match(odd.text, /WARNING.*EOTHER/);
  const thrown = await run(async () => { throw Object.assign(new Error('x'), { code: 'EBOOM' }); });
  assert.match(thrown.text, /EBOOM/);
});
