import {it,expect,vi} from 'vitest';
import {OpenAiProvider,parseAiConfig} from './ai-provider.js';
const config={apiKey:'fixture-private-key',model:'fixture-model'};
const context={kind:'graph' as const,prompt:'Turn the LED on',signals:[{id:'led',name:'LED',dataType:'boolean',direction:'output'}]};
const envelope={name:'LED logic',summary:'A reviewed constant output',document:JSON.stringify({schemaVersion:1,nodes:[],edges:[]})};
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
it('uses the configured model and server-only credential with a bounded no-tool structured response',async()=>{
  const transport=vi.fn().mockResolvedValue(response({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(envelope)}]}]}));
  const provider=new OpenAiProvider(config,transport);
  expect(await provider.generate(context)).toEqual(envelope);
  const [url,init]=transport.mock.calls[0]!; expect(url).toBe('https://api.openai.com/v1/responses');expect(init.headers.Authorization).toBe('Bearer fixture-private-key');expect(init.redirect).toBe('error');
  const body=JSON.parse(init.body);expect(body.model).toBe('fixture-model');expect(body.store).toBe(false);expect(body.tools).toBeUndefined();expect(body.max_output_tokens).toBe(8192);expect(body.text.format.strict).toBe(true);
  expect(JSON.stringify(body)).not.toContain(config.apiKey);expect(body.input).toContain('Turn the LED on');
});
it('rejects incomplete, refused, malformed and oversized replies without leaking provider error bodies',async()=>{
  for(const value of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'private internal message'}]}]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'invalid'}]}]}]) {
    const provider=new OpenAiProvider(config,async()=>response(value));await expect(provider.generate(context)).rejects.toThrow(/AI/);
  }
  await expect(new OpenAiProvider(config,async()=>new Response('fixture-private-key',{status:401})).generate(context)).rejects.not.toThrow('fixture-private-key');
  await expect(new OpenAiProvider(config,async()=>new Response('x'.repeat(262145))).generate(context)).rejects.toThrow(/limit/);
});
it('bounds configuration and refuses unknown properties',()=>{
  expect(parseAiConfig(config)).toEqual(config);
  for(const value of [{...config,model:''},{...config,apiKey:''},{...config,baseUrl:'http://evil.invalid'},{...config,apiKey:'bad\nkey'}]) expect(()=>parseAiConfig(value)).toThrow();
});

it('rejects concurrent calls and releases its slot after a bounded timeout',async()=>{
  vi.useFakeTimers();
  try {
    let attempt=0;
    const transport:typeof fetch=async(_url,init)=>{
      attempt++;
      if(attempt>1)return response({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(envelope)}]}]});
      return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    };
    const provider=new OpenAiProvider(config,transport);const pending=provider.generate(context);
    const timeout=expect(pending).rejects.toThrow(/timed out/);
    await expect(provider.generate(context)).rejects.toThrow(/already in progress/);
    await vi.advanceTimersByTimeAsync(30000);await timeout;
    expect(await provider.generate(context)).toEqual(envelope);
  } finally {vi.useRealTimers();}
});
