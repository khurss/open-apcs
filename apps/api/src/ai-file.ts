import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {parseAiConfig,type AiConfig} from './ai-provider.js';
export async function loadAiConfig(path:string):Promise<AiConfig> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>{throw new Error('AI configuration unavailable');});
  try {
    const info=await file.stat();
    if(!info.isFile()||(info.mode&0o077))throw new Error('AI configuration requires a private regular file');
    if(info.size>8192)throw new Error('AI configuration exceeds the size limit');
    const bytes=Buffer.alloc(8193);const {bytesRead}=await file.read(bytes,0,bytes.length,0);
    if(bytesRead>8192)throw new Error('AI configuration exceeds the size limit');
    let value:unknown;try{value=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));}catch{throw new Error('Invalid AI configuration JSON');}
    return parseAiConfig(value);
  }finally{await file.close();}
}
