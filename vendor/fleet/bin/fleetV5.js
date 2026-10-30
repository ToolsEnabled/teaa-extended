#!/usr/bin/env node
'use strict';
process.umask(0o077);
const path = require('node:path');
const product = Object.freeze({
  name: 'fleetV5',
  generation: 5,
  entry: __filename,
  metadata: require('../fleetV5.json'),
  defaultStateRoot: () => path.join(require('node:os').homedir(), '.fleetV5')
});
const main = argv => require('./fleetV2').main(argv, product);
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.code || 'FLEET_V5_ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});
module.exports = { main, product };
