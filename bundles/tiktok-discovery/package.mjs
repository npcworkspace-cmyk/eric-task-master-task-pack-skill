import { cli } from './skills/tiktok-discovery-retrospective/scripts/evolve.mjs';
await cli(['package', ...process.argv.slice(2)]).catch(e => { console.error(e.message); process.exitCode = 1; });
