import {readFileSync,writeFileSync} from 'node:fs';
import {summarizeDeviceTrace} from '../../packages/bench/src/transport-evidence.js';
const file=process.argv[2];
if(!file?.startsWith('/artifacts/')||!file.endsWith('.jsonl'))throw new Error('Explicit artifact JSONL required');
const rows=readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).device);
const report=summarizeDeviceTrace(rows);
writeFileSync(`${file}.summary.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
