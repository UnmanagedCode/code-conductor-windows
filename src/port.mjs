// The port cc listens on (cc's launcher and server read PORT): validation
// before setup downloads anything, and an advisory install-time check.
import net from 'node:net';

// The port as a Number, or a throw. Only the canonical decimal form passes:
// the installer compares the chosen and current ports as strings, and NSIS
// would read a leading 0 as octal.
export function checkPort(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`the port must be a whole number from 1 to 65535 (no sign or leading zero): ${raw}`);
  }
  return Number(raw);
}

// null when 127.0.0.1:<port> (cc's default bind address) can be bound, else
// the error code.
export function tryListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code ?? String(e.message)));
    srv.listen({ port, host: '127.0.0.1' }, () => srv.close(() => resolve(null)));
  });
}

// Logs whether the port can be bound; true when it cannot. Advisory: never
// throws, never blocks the install. Ports below 1024 need no special case,
// Windows does not restrict them for ordinary processes.
export async function warnIfPortTaken(port, { log, listen = tryListen }) {
  let code;
  try { code = await listen(port); } catch (e) { code = e?.code ?? String(e?.message ?? e); }
  if (code === null) {
    log(`port: ${port}`);
    return false;
  }
  if (code === 'EADDRINUSE') {
    log(`port: WARNING ${port} is in use by another program now (EADDRINUSE); code-conductor will not start until it is free (or run the installer again with another port)`);
  } else if (code === 'EACCES') {
    log(`port: WARNING ${port} cannot be used (EACCES), possibly in a Windows reserved range (netsh interface ipv4 show excludedportrange protocol=tcp)`);
  } else {
    log(`port: WARNING could not check ${port} (${code})`);
  }
  return true;
}
