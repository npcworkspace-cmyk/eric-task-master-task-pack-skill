import { cli } from './skills/tiktok-discovery-retrospective/scripts/deployment.mjs';
await cli().catch(e => { console.error(e.message); process.exitCode = 1; });
