/**
 * CLI helpers:  node src/cli.js collect | worker | seed | resolve <callId> | process <callId> | probe
 */
import { config } from './config.js';
import { seedDefaults, q } from './db.js';
import { ensureAdmin } from './auth.js';
import { collectAll, probeWarehouses } from './collector.js';
import { runWorkerLoop, processCall } from './worker.js';
import { startMaintenance } from './maintenance.js';
import { resolveRecording, probeGateway } from './gateway.js';

const cmd = process.argv[2];
seedDefaults(); ensureAdmin();

switch (cmd) {
  case 'collect': { const r = await collectAll(); console.log(r); process.exit(0); }
  case 'worker': { runWorkerLoop(); startMaintenance(); break; }
  case 'seed': { console.log('seeded'); process.exit(0); }
  case 'probe': { console.log(JSON.stringify({ warehouses: await probeWarehouses(), gateway: await probeGateway() }, null, 2)); process.exit(0); }
  case 'resolve': { const c = q.one('SELECT * FROM calls WHERE id=?', Number(process.argv[3])); console.log(await resolveRecording(c, { force: true })); process.exit(0); }
  case 'process': { await processCall(Number(process.argv[3])); process.exit(0); }
  default: console.log('usage: node src/cli.js collect|worker|seed|probe|resolve <id>|process <id>'); process.exit(1);
}
