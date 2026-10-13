import {it,expect} from 'vitest';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAiConfig} from './ai-file.js';
it('loads only a bounded private regular AI configuration file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'apcs-ai-')); const path=join(directory,'private.json');
  try {
    const config={apiKey:'fixture-private-key',model:'fixture-model'};
    await writeFile(path,JSON.stringify(config),{mode:0o600});expect(await loadAiConfig(path)).toEqual(config);
    await chmod(path,0o644);await expect(loadAiConfig(path)).rejects.toThrow(/private/);
    await chmod(path,0o600);await symlink(path,join(directory,'link'));await expect(loadAiConfig(join(directory,'link'))).rejects.toThrow();
    await writeFile(path,'x'.repeat(8193));await expect(loadAiConfig(path)).rejects.toThrow(/size/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
