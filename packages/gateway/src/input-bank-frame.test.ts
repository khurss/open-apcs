import {expect,it} from 'vitest';
import {parseInputBankFrame} from './input-bank-frame.js';
const frame = {v:1,bootId:'current',sequence:4,values:[4,104]};
const parse = (value:unknown) => parseInputBankFrame(Buffer.from(JSON.stringify(value)),'current',2);
it('accepts a complete bounded bank without changing channel order',()=>{
  expect(parse(frame)).toEqual({sequence:4,values:[4,104]});
});
it('rejects an entire malformed bank before any channel is applied',()=>{
  for (const value of [null,[],{...frame,extra:true},{...frame,bootId:'old'},{...frame,sequence:-1},{...frame,sequence:1.5},{...frame,values:[1]},{...frame,values:[1,2,3]},{...frame,values:[1,null]},{...frame,values:[1,'2']},{...frame,values:[-1,101]},{...frame,values:[1,200]}]) expect(()=>parse(value)).toThrow();
  expect(()=>parseInputBankFrame(Buffer.from('x'.repeat(2049)),'current',2)).toThrow();
  expect(()=>parseInputBankFrame(Buffer.from('{'),'current',2)).toThrow();
});
