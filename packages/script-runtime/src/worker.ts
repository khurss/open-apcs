import { parentPort } from 'node:worker_threads';
import ts from 'typescript';
import { getQuickJS } from 'quickjs-emscripten';
import type { ScriptResponse } from './queue.js';
import { parseScriptRequest } from './contract.js';
if (!parentPort) throw new Error('Script worker requires a parent');
const quickjs = await getQuickJS();
const compiled = new Map<string, string>();
function compile(source: string, language: string): string {
  const key = `${language}:${source}`; const cached = compiled.get(key); if (cached) return cached;
  const parameters = language === 'typescript' ? 'input: Readonly<{ a: boolean; b: boolean }>, nowMs: number' : 'input, nowMs';
  const wrapped = `function __apcs(${parameters}) { "use strict";\n${source}\n}`;
  const syntax = ts.createSourceFile('block.ts', wrapped, ts.ScriptTarget.ES2022, true, language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (syntax.statements.length !== 1 || !ts.isFunctionDeclaration(syntax.statements[0]!) || syntax.statements[0].name?.text !== '__apcs') throw new Error('Only a function body is allowed');
  const result = ts.transpileModule(wrapped, { fileName: language === 'typescript' ? 'block.ts' : 'block.js', reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, allowJs: true, removeComments: true } });
  if (result.diagnostics?.some((entry) => entry.category === ts.DiagnosticCategory.Error) || result.outputText.length > 65536) throw new Error('Script syntax rejected');
  if (compiled.size >= 32) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, result.outputText); return result.outputText;
}
parentPort.on('message', (message: { id: number; request: unknown }) => {
  try {
    const request = parseScriptRequest(message.request); const source = compile(request.source, request.language);
    const runtime = quickjs.newRuntime(); runtime.setMemoryLimit(8 * 1024 * 1024); runtime.setMaxStackSize(256 * 1024);
    const end = performance.now() + 100; runtime.setInterruptHandler(() => performance.now() >= end);
    let response: ScriptResponse;
    const vm = runtime.newContext(); const handles: Array<ReturnType<typeof vm.newNumber>> = [];
    const take = (result: ReturnType<typeof vm.evalCode>) => { if (result.error) { result.error.dispose(); throw new Error('Script execution rejected'); } handles.push(result.value); return result.value; };
    try {
      take(vm.evalCode('globalThis.Date = undefined; Math.random = undefined;'));
      const inputs = take(vm.evalCode(`Object.freeze(${JSON.stringify(request.inputs)})`));
      const fn = take(vm.evalCode(`${source}\n__apcs;`, 'block.js'));
      if (vm.typeof(fn) !== 'function') throw new Error('Script function required');
      if (request.mode === 'validate') response = { valid: true };
      else {
        const now = vm.newNumber(request.nowMs); handles.push(now);
        const result = take(vm.callFunction(fn, vm.undefined, inputs, now));
        if (vm.typeof(result) !== 'boolean') throw new Error('Boolean script result required');
        response = { value: vm.dump(result) as boolean };
      }
    } finally { for (const handle of handles.reverse()) handle.dispose(); vm.dispose(); runtime.dispose(); }
    parentPort!.postMessage({ id: message.id, result: response });
  } catch { parentPort!.postMessage({ id: message.id, error: 'Script execution rejected' }); }
});
parentPort.postMessage({ ready: true });
