'use strict';

// Parent of the attach proxy in mirror mode (see hub-lead-bridge.cjs). Started
// with argv0 set to the remote lead's agent command and that agent's own level
// words, so the hub's /proc walk reads the level the remote reported. It holds
// no state: it runs the proxy from FLEET_HUB_LEAD_PROXY, passes signals, and
// exits with it.

const { spawn } = require('node:child_process');

const proxy = JSON.parse(process.env.FLEET_HUB_LEAD_PROXY || 'null');
if (!Array.isArray(proxy) || proxy.length < 2 || !proxy.every(word => typeof word === 'string')) {
  process.stderr.write('[level-holder] refused: no proxy command was given.\n');
  process.exit(2);
}
const env = { ...process.env };
delete env.FLEET_HUB_LEAD_PROXY;
const child = spawn(proxy[0], proxy.slice(1), { stdio: 'inherit', env });
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
