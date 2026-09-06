import { inspectEnvironment, loadRuntimeConfig } from './runtime/environment.mjs';
const args = process.argv.slice(2);
try {
  if (args.some((a, i) => a !== '--config' && args[i - 1] !== '--config') || (args.includes('--config') && !args[args.indexOf('--config') + 1])) throw Error('Usage: node doctor.mjs [--config environment.json]');
  const index = args.indexOf('--config');
  const result = await inspectEnvironment(index < 0 ? {} : await loadRuntimeConfig(args[index + 1]));
  console.log(JSON.stringify(result, null, 2));
  if (result.missing.length) process.exitCode = 2;
} catch (error) { console.error(JSON.stringify({ status: 'configuration_error', error: error.message })); process.exitCode = 1; }
