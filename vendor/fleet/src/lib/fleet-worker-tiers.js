'use strict';

// Worker selections for the Fleet tree. Fleet ships no models: each agent's
// selections are its own default ("<agent>") and the models its own program
// lists ("<agent>/<model id>"), read once per process by
// src/lib/agents/model-discovery.js. Discovering a worker never starts a
// dispatcher or a provider session; where an agent's list is behind its own
// listing command (`grok models`), that command alone is run, once.
//
// Only agents that speak a worker protocol this build can drive are offered,
// so the tree never advertises a worker it cannot start.
const { activeRegistry, workerAgentIds } = require('./agents/registry');
const { workerChoices } = require('./agents/model-discovery');

const registry = activeRegistry();

module.exports = workerChoices(registry, workerAgentIds(registry)).rows;
