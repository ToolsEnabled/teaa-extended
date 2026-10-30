'use strict';
const fs = require('fs');
const path = require('path');

const WORKER_MANUAL_PATH = path.join(__dirname, '..', '..', 'docs', 'WORKER-MANUAL.md');
function workerManualText() {
  try {
    const text = fs.readFileSync(WORKER_MANUAL_PATH, 'utf8').trim();
    if (text) return text;
  } catch { /* report missing or unreadable document below */ }
  return 'The Fleet interior manual (docs/WORKER-MANUAL.md in the Fleet runtime) could not be read; report this to the lead through fleet.control. Never message peers directly.';
}
module.exports = { WORKER_MANUAL_PATH, workerManualText };
