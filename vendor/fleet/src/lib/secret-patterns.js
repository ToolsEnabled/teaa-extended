'use strict';

// One definition of provider-issued credential shapes currently accepted by
// vault consumers. Key-name redaction remains the primary control; these
// patterns catch a value that has already been flattened into free text.
const KNOWN_PROVIDER_CREDENTIAL_SOURCE = String.raw`(?:(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{24,}|GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9._-]{8,}|1\/\/[A-Za-z0-9_-]{20,}|do[op]_v1_[A-Fa-f0-9]{40,}|tvly-[A-Za-z0-9_-]{20,}|pdl_[A-Za-z0-9_-]{20,}|IGQ[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})`;
const PLAINTEXT_CREDENTIAL_SOURCE = String.raw`(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{20,}|\b${KNOWN_PROVIDER_CREDENTIAL_SOURCE}\b)`;

function knownProviderCredentialPattern(flags = 'i') {
  return new RegExp(String.raw`\b${KNOWN_PROVIDER_CREDENTIAL_SOURCE}\b`, flags);
}

function plaintextCredentialPattern(flags = 'i') {
  return new RegExp(PLAINTEXT_CREDENTIAL_SOURCE, flags);
}

const CREDENTIAL_KEY = String.raw`(?:(?:[A-Za-z][A-Za-z0-9_.-]*[_-])?(?:access[_-]?(?:token|key)|refresh[_-]?token|client[_-]?secret|api[_-]?key|token|secret|password|passwd|passphrase|authorization|cookie|cvc|cvv|security[_-]?code|private[_-]?key|credentials?)|[A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|credentials?))`;
const CREDENTIAL_PREFIX = new RegExp(String.raw`(?<![A-Za-z0-9_.\\-])(?:\\*["'])?${CREDENTIAL_KEY}(?:\\*["'])?\s*[:=][ \t]*`, 'gi');

// Provider errors can quote configuration absent from this process's env.
// Scan quoted values rather than stopping at their first space/comma, and
// retain delimiters and adjacent diagnostics. Run before any length bound.
function redactCredentialPairs(text) {
  const pieces = [];
  let cursor = 0, scanned = 0, opened = -1, closedBrace = -1, lineStart = 0;
  const yamlKeyAt = start => {
    let key = start;
    while (/[ \t]/.test(text[key] || 'x')) key++;
    if (text[key] === '-' && /[ \t]/.test(text[key + 1] || 'x')) {
      key++;
      while (/[ \t]/.test(text[key] || 'x')) key++;
    }
    return key;
  };
  let lineKey = yamlKeyAt(0);
  for (const match of text.matchAll(CREDENTIAL_PREFIX)) {
    if (match.index < cursor) continue;
    for (; scanned < match.index; scanned++) {
      if (text[scanned] === '{') opened = scanned;
      else if (text[scanned] === '}') closedBrace = scanned;
      else if (text[scanned] === '\n') { lineStart = scanned + 1; lineKey = yamlKeyAt(lineStart); }
    }
    let start = match.index + match[0].length;
    const flow = match[0].trimEnd().endsWith(':') && opened > closedBrace;
    if (flow) while (start < text.length && /\s/.test(text[start])) start++;
    let end = start, replacement = 'REDACTED';
    let slashes = 0;
    while (text[start + slashes] === '\\') slashes++;
    const quote = text[start + slashes];
    const yaml = match.index === lineKey && match[0].trimEnd().endsWith(':');
    if (quote === '"' || quote === "'") {
      const delimiter = '\\'.repeat(slashes) + quote;
      end = start + delimiter.length;
      let run = 0, closed = false;
      for (; end < text.length; end++) {
        const char = text[end];
        if (char === quote && run % (2 * (slashes + 1)) === slashes) {
          if (yaml && quote === "'" && slashes === 0 && text[end + 1] === "'") { end++; run = 0; continue; }
          end++; closed = true; break;
        }
        run = char === '\\' ? run + 1 : 0;
      }
      replacement = delimiter + 'REDACTED' + (closed ? delimiter : '');
    } else if (flow) {
      while (end < text.length && !/[,}\]]/.test(text[end])) end++;
      while (end > start && /\s/.test(text[end - 1])) end--;
    } else if (yaml) {
      const header = /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)[ \t]*(?:#[^\r\n]*)?\r?\n/.exec(text.slice(start));
      if (header) {
        // A YAML block scalar belongs to this key until indentation returns
        // to the key's level. Keep the header and following nonsecret fields.
        const indent = match.index - lineStart;
        end = start + header[0].length;
        while (end < text.length) {
          const newline = text.indexOf('\n', end), limit = newline < 0 ? text.length : newline + 1;
          const line = text.slice(end, limit);
          if (line.trim() && /^[ \t]*/.exec(line)[0].length <= indent) break;
          end = limit;
        }
        replacement = redactCredentialPairs(header[0]) + ' '.repeat(indent + 2) + 'REDACTED\n';
      } else {
        while (end < text.length && !/[\r\n]/.test(text[end]) && !(text[end] === '#' && /\s/.test(text[end - 1]))) end++;
        // Preserve whitespace before a YAML comment or the next line.
        while (end > start && /[ \t]/.test(text[end - 1])) end--;
      }
    } else {
      while (end < text.length && !/[\s,}&\]#;)]/.test(text[end])) end++;
    }
    if (end === start) continue;
    pieces.push(text.slice(cursor, start), replacement);
    cursor = end;
    // Credential contents are data, not surrounding JSON/YAML structure.
    // Skip their braces, while advancing line context in one linear pass.
    for (; scanned < end; scanned++) if (text[scanned] === '\n') { lineStart = scanned + 1; lineKey = yamlKeyAt(lineStart); }
  }
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

/* IDS THIS PRODUCT MINTS FROM A DIGEST ARE NOT CREDENTIALS.
 *
 * A circle's agent id is `tree-` plus 24 lower-case hex characters of a
 * SHA-256 digest (agent-comms/tree-node-directory.js agentIdForSession), and
 * its inbox is `direct.` plus 64 (agent-comms/fabric.js streamIdForAudience).
 * The patterns above are case-insensitive, and EAA is also hex, so about one
 * inbox in 4,300 and one circle id in 4,100 begin `eaa` and matched the
 * Facebook token shape. The durable message store then refused every message
 * to or from that circle, for good, because its ids never change.
 *
 * A contract part is keyed `part-` plus the SHA-256 digest of its JSON value.
 * Since that digest is also lower-case hex, a part key can have the same
 * accidental EAA prefix. It is treated as a generated identifier by its exact
 * product shape, like the existing tree and inbox ids.
 *
 * A match is excused only when it lies wholly inside one of those generated ids,
 * written exactly: lower-case hex of the exact length, with no letter, digit,
 * `_`, `-` or `.` on either side. Nothing a provider issues fits inside that:
 * the only pattern above that lower-case hex can satisfy is the EAA one. Every
 * other match in the same text is judged as before, so a token beside an id,
 * an id with anything added, `Bearer <id>`, and digest-looking text that is
 * not one of these ids are all still refused. */
const GENERATED_IDENTIFIER_SOURCE = String.raw`(?<![A-Za-z0-9_.-])(?:direct\.[0-9a-f]{64}|tree-[0-9a-f]{24}|part-[0-9a-f]{64})(?![A-Za-z0-9_-])`;

function plaintextCredentialOutsideGeneratedIds(text) {
  if (typeof text !== 'string') return false;
  let ids = null;
  for (const match of text.matchAll(plaintextCredentialPattern('gi'))) {
    if (ids === null) {
      ids = Array.from(text.matchAll(new RegExp(GENERATED_IDENTIFIER_SOURCE, 'g')),
        id => [id.index, id.index + id[0].length]);
    }
    const start = match.index;
    const end = start + match[0].length;
    if (!ids.some(([from, to]) => start >= from && end <= to)) return true;
  }
  return false;
}

module.exports = Object.freeze({
  GENERATED_IDENTIFIER_SOURCE,
  KNOWN_PROVIDER_CREDENTIAL_SOURCE,
  PLAINTEXT_CREDENTIAL_SOURCE,
  knownProviderCredentialPattern,
  redactCredentialPairs,
  plaintextCredentialOutsideGeneratedIds,
  plaintextCredentialPattern
});
