// Official Pi extension for Fleet workers. This registers only the worker's
// own MCP identity; read/edit use the same native bridge as direct Pi.
import fs from 'node:fs';
import fleetPiExtension from './pi-fleet-extension.mjs';

export default async function fleetPiWorker(pi) {
  const file = process.env.FLEET_PI_WORKER_CONFIG;
  if (!file) throw new Error('PI_WORKER_BINDING_REQUIRED: private node configuration is missing.');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.fleetServer) pi.registerMcpServer(config.serverName, { ...config.fleetServer, exposure: 'direct' });
  await fleetPiExtension(pi);
}
