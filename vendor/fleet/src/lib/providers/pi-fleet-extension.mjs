// Loadable Pi extension. The official edit and read tools keep their schemas,
// transformations and result text. Publication and observation go through the
// existing host byte authority. Loading this module does not edit a file.
// write and bash are not replaced. CodeMode is Pi's package, not a new engine.
// Fleet worker lifecycle uses the same extension through pi-worker-extension.mjs.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const bridge = require('./pi-host-bridge.js');

export function piPackagePath() {
  return bridge.piPackageFile();
}

export async function loadOfficialPi() {
  const file = piPackagePath();
  if (!file) {
    const error = new Error('Official @earendil-works/pi-coding-agent 1.4.0 could not be resolved from the native Pi CLI or FLEET_PI_PACKAGE.');
    error.code = 'PI_PACKAGE_ABSENT';
    throw error;
  }
  return import(pathToFileURL(file).href);
}

export default async function fleetPiExtension(pi) {
  const coding = await loadOfficialPi();
  const workspace = process.env.FLEET_PI_WORKSPACE || process.cwd();
  const officialEdit = coding.createEditToolDefinition(workspace);
  const officialRead = coding.createReadToolDefinition(workspace);
  const parameterKeys = Object.keys(officialEdit.parameters.properties).sort();
  const editKeys = Object.keys(officialEdit.parameters.properties.edits.items.properties).sort();
  if (officialEdit.name !== 'edit' || parameterKeys.join() !== 'edits,path' || editKeys.join() !== 'newText,oldText') {
    throw new Error('The installed Pi edit tool schema is not the 1.4.0 path/edits contract.');
  }
  if (officialRead.name !== 'read') {
    throw new Error('The installed Pi read tool schema is not the 1.4.0 read contract.');
  }

  let client;
  function hostClient() {
    if (!client) client = bridge.openHostClient({ harness: 'pi', workspace });
    return client;
  }

  pi.on('session_shutdown', async () => { if (client) { await client.close(); client = null; } });

  pi.registerTool({
    ...officialRead,
    execute: (toolCallId, params, signal, onUpdate, context) => bridge.readVisible(hostClient(), params || {}, signal, { toolCallId, onUpdate, context })
  });
  pi.registerTool({
    ...officialEdit,
    execute: (toolCallId, params, signal, onUpdate, context) => bridge.editOfficial(hostClient(), params || {}, signal, { toolCallId, onUpdate, context })
  });
  pi.registerCommand('fleet-pi-status', {
    description: 'Report the Fleet Pi edit adapter without calling a model.',
    handler: async () => ({
      content: [{ type: 'text', text: 'fleet-pi-edit host-byte-authority; pi-rpc-worker-driver' }]
    })
  });
}
