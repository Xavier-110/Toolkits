import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { convert } from '../src/core.js';

const env = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ name: `KEY_${5000 - i}`, value: `value-${i}` })));
const json = JSON.stringify(Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [`KEY_${12000 - i}`, 'x'.repeat(68)])));
const yaml = convert(env, { format: 'env-json', target: 'yaml' }).text;
const results = [];
for (const [name, input, options] of [
  ['JSON format/sort', json, { format: 'json', target: 'json' }],
  ['5,000 env JSON -> YAML', env, { format: 'env-json', target: 'yaml' }],
  ['5,000 env YAML -> JSON', yaml, { format: 'yaml', target: 'env-json' }],
]) {
  convert(input, options);
  const times = [];
  for (let i = 0; i < 3; i++) { const start = performance.now(); convert(input, options); times.push(performance.now() - start); }
  results.push({ name, inputBytes: Buffer.byteLength(input), milliseconds: times.map(x => Math.round(x)), maxMilliseconds: Math.round(Math.max(...times)) });
}
console.log(JSON.stringify({ node: process.version, os: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0].model, results }, null, 2));
if (results.some(r => r.maxMilliseconds >= 1000)) process.exitCode = 1;
