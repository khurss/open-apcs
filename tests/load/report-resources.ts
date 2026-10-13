import {readFileSync,writeFileSync} from 'node:fs';
import {assessResources} from '../../packages/bench/src/resources.js';
const directory = process.argv[2];
if (!directory || !/^\/artifacts\/l0-host-[a-f0-9]{32}$/.test(directory)) throw new Error('Explicit host evidence directory required');
const result = assessResources(readFileSync(`${directory}/resources.jsonl`,'utf8').trim().split('\n').map(line=>JSON.parse(line)));
writeFileSync(`${directory}/resource-result.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
if (!result.passed) throw new Error('L0 resource bounds exceeded');
