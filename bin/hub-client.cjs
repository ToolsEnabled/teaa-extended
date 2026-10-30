'use strict';
require('../vendor/hub/remote/remote-lead-mcp.cjs').main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
