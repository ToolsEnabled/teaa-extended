'use strict';
// Numeric usage only. Provider formats differ: cache/reasoning breakdowns are
// not additional tokens unless the provider explicitly defines them that way.
const FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const ISSUE_CODES = Object.freeze(['token-total-conflict', 'cache-subset-conflict', 'reasoning-subset-conflict']);
const COVERAGE_ISSUES = Object.freeze(['native-child-usage-unobserved', 'session-usage-not-turn-bounded']);
const sum = values => values.every(count) && Number.isSafeInteger(values.reduce((a, b) => a + b, 0)) ? values.reduce((a, b) => a + b, 0) : undefined;
function pick(out, key, value) { if (count(value)) out[key] = value; }
function normalize(raw, format) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (format === 'canonical') {
    for (const key of FIELDS) pick(out, key, raw[key]);
    return out;
  }
  if (format === 'anthropic') {
    pick(out, 'uncachedInputTokens', raw.input_tokens);
    pick(out, 'cacheReadTokens', raw.cache_read_input_tokens);
    pick(out, 'cacheWriteTokens', raw.cache_creation_input_tokens);
    pick(out, 'inputTokens', sum([out.uncachedInputTokens, out.cacheReadTokens, out.cacheWriteTokens]));
    pick(out, 'outputTokens', raw.output_tokens);
  } else if (format === 'openai-chat' || format === 'openai-responses') {
    const chat = format === 'openai-chat';
    pick(out, 'inputTokens', raw[chat ? 'prompt_tokens' : 'input_tokens']);
    pick(out, 'outputTokens', raw[chat ? 'completion_tokens' : 'output_tokens']);
    pick(out, 'totalTokens', raw.total_tokens);
    const input = raw[chat ? 'prompt_tokens_details' : 'input_tokens_details'];
    const output = raw[chat ? 'completion_tokens_details' : 'output_tokens_details'];
    pick(out, 'cacheReadTokens', input?.cached_tokens);
    pick(out, 'cacheWriteTokens', input?.cache_write_tokens);
    pick(out, 'reasoningTokens', output?.reasoning_tokens);
  } else if (format === 'codex' || format === 'acp') {
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) pick(out, key, raw[key]);
    pick(out, 'cacheReadTokens', raw[format === 'codex' ? 'cachedInputTokens' : 'cachedReadTokens']);
    pick(out, 'cacheWriteTokens', raw[format === 'codex' ? 'cacheWriteInputTokens' : 'cachedWriteTokens']);
    pick(out, 'reasoningTokens', raw[format === 'codex' ? 'reasoningOutputTokens' : 'thoughtTokens']);
  } else if (format === 'ollama') {
    pick(out, 'inputTokens', raw.prompt_eval_count); pick(out, 'outputTokens', raw.eval_count);
  }
  // ACP's draft accounting semantics are provider-reported; do not invent a
  // sum or subtract its optional cache/thought counters from its input/output.
  if (format !== 'acp' && out.totalTokens === undefined) pick(out, 'totalTokens', sum([out.inputTokens, out.outputTokens]));
  if (['openai-chat', 'openai-responses', 'codex'].includes(format)
      && count(out.inputTokens) && count(out.cacheReadTokens) && count(out.cacheWriteTokens))
    pick(out, 'uncachedInputTokens', out.inputTokens - out.cacheReadTokens - out.cacheWriteTokens);
  return out;
}
function add(left, right) {
  // Exact sums only. If any component is unknown, the total for that field is
  // unknown. Accounting views separately retain measured subtotals.
  const out = {};
  for (const key of FIELDS) pick(out, key, sum([left[key], right[key]]));
  return out;
}
function issues(value, format = 'canonical') {
  // ACP components have provider-defined semantics. Keep its reported total
  // without applying another protocol's subset rules.
  if (format === 'acp') return [];
  const out = [];
  if (count(value.inputTokens) && count(value.outputTokens) && count(value.totalTokens)
      && value.inputTokens + value.outputTokens !== value.totalTokens) out.push('token-total-conflict');
  if (count(value.inputTokens) && ((count(value.cacheReadTokens) && value.cacheReadTokens > value.inputTokens)
      || (count(value.cacheWriteTokens) && value.cacheWriteTokens > value.inputTokens)
      || (count(value.cacheReadTokens) && count(value.cacheWriteTokens) && value.cacheReadTokens + value.cacheWriteTokens > value.inputTokens))) out.push('cache-subset-conflict');
  if (count(value.outputTokens) && count(value.reasoningTokens) && value.reasoningTokens > value.outputTokens) out.push('reasoning-subset-conflict');
  return out;
}
function measuredSum(samples) {
  const values = {}, coverage = {};
  for (const key of FIELDS) {
    const known = samples.filter(sample => count(sample?.[key])).map(sample => sample[key]);
    const total = sum(known);
    if (known.length && count(total)) values[key] = total;
    coverage[key] = known.length;
  }
  return { values, coverage, samples: samples.length };
}
module.exports = { FIELDS, ISSUE_CODES, COVERAGE_ISSUES, count, sum, normalize, issues, add, measuredSum };
