'use strict';
const fs = require('fs');
const path = require('path');

// The lead manual: one static document, shipped in the archive beside this
// module and identical for every user. The lead's MCP instructions carry it
// verbatim, so docs/LEAD-MANUAL.md is the only copy to edit. A read failure is
// said in the instructions rather than looking like there is no manual.
const LEAD_MANUAL_PATH = path.join(__dirname, '..', '..', 'docs', 'LEAD-MANUAL.md');

function leadManualText() {
  try {
    const text = fs.readFileSync(LEAD_MANUAL_PATH, 'utf8').trim();
    if (text) return text;
  } catch { /* reported below */ }
  return 'The Fleet lead manual (docs/LEAD-MANUAL.md in the Fleet runtime) could not be read; report this to the person.';
}

module.exports = { LEAD_MANUAL_PATH, leadManualText };
