import { pidThermostatGraph } from '../../../packages/domain/src/pid-template.js';
import type { DocumentDiff } from '../../../packages/domain/src/document-diff.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, useNodesState, type Connection, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ports, outputType, portType, validateGraph, type BlockKind, type LogicGraph, type LogicNode, type LogicResult } from '../../../packages/domain/src/logic.js';
import { canonicalJson, EditHistory, validateScreen, type Screen, type ScreenItem } from '../../../packages/domain/src/screen.js';
import { api, type Project, type Device, type Signal, type Page } from './api.js';
import './editors.css';
import { ScreenOperator } from './screen-operator.js';
import { GraphRuntimePanel } from './graph-runtime.js';

type Document = LogicGraph | Screen;
type Kind = 'graph' | 'screen';
interface Draft { id: string; projectId: string; name: string; revision: number; document: Document; }
interface Props { kind: Kind; projects: Project[]; devices: Device[]; signals: Signal[]; initialProject: string; onDirty: (dirty: boolean) => void; }
const labels: Record<BlockKind, string> = { constant: 'Constant', input: 'Input', output: 'Output', not: 'NOT', and: 'AND', or: 'OR', xor: 'XOR', ton: 'On-delay', tof: 'Off-delay', pulse: 'Pulse', debounce: 'Debounce', latch: 'Latch', interlock: 'Interlock', mode: 'Auto / Manual', script: 'JS / TS script', number: 'Numeric constant', analog: 'Numeric input', add: 'Add', subtract: 'Subtract', multiply: 'Multiply', divide: 'Divide', greater: 'Greater than', less: 'Less than', hysteresis: 'Hysteresis', filter: 'Low-pass filter', counter: 'Rising-edge counter', pid: 'PID controller', pwm: 'Time proportioning', schedule: 'Weekly schedule' };
const timed = new Set<BlockKind>(['ton', 'tof', 'pulse', 'debounce']);
const displayValue = (value: boolean | number | null): string => value === null ? 'Unavailable' : typeof value === 'boolean' ? value ? 'ON' : 'OFF' : String(value);
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }

export function EditorWorkspace({ kind, projects, devices, signals, initialProject, onDirty }: Props) {
  const [projectId, setProjectId] = useState(initialProject || projects[0]?.id || '');
  const [list, setList] = useState<Page<Draft>>({ items: [], nextCursor: null });
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const history = useRef<EditHistory<Document> | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [simStart, setSimStart] = useState('');
  const [simulation, setSimulation] = useState<LogicResult | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState('');
  const [simInputs, setSimInputs] = useState<Record<string, boolean | number | null>>({});
  const [revisions, setRevisions] = useState<Array<{ revision: number; checksum: string }>>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [compareTarget, setCompareTarget] = useState('draft');
  const [comparison, setComparison] = useState<(DocumentDiff & { baseRevision: number; targetRevision: number; target: string }) | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const editEpoch = useRef(0);
  const [operator, setOperator] = useState<{ document: Screen; revision: number } | null>(null);
  const [blockKind, setBlockKind] = useState<BlockKind>('constant');
  const [thermalDeviceId, setThermalDeviceId] = useState('');
  const thermalDevices = devices.filter((d) => d.projectId === projectId && d.kind === 'virtual-thermal');
  const templateDevice = thermalDevices.find((d) => d.id === thermalDeviceId) ?? thermalDevices[0];
  const dirty = !!draft && canonicalJson(document) !== canonicalJson(draft.document);
  const available = signals.filter((s) => devices.some((d) => d.id === s.deviceId && d.projectId === projectId));
  const outputSignal = available.find((s) => s.direction === 'output' && s.dataType === 'boolean');
  useEffect(() => { if (!projectId && projects.length) setProjectId(initialProject || projects[0]!.id); }, [projectId, projects, initialProject]);
  useEffect(() => { onDirty(dirty); const prevent = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', prevent); return () => { onDirty(false); window.removeEventListener('beforeunload', prevent); }; }, [dirty, onDirty]);
  useEffect(() => {
    let active = true;
    if (projectId) void api<Page<Draft>>(`/projects/${projectId}/${kind}s`).then((items) => { if (active) setList(items); }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [projectId, kind]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Operation failed'); } finally { setBusy(false); } }
  function accept(row: Draft) { editEpoch.current++; setComparison(null); setRestoreReason(''); setCompareTarget('draft'); setNextBefore(null); setDraft(row); setDocument(row.document); history.current = new EditHistory(row.document); setSelected(''); setSimulation(null); setTextMode(false); setSimInputs({}); setRevisions([]); }
  function edit(next: Document) { editEpoch.current++; setComparison(null); history.current!.set(next); setDocument(history.current!.current); setMessage(''); setSimulation(null); }
  function discardAllowed() { return !dirty || window.confirm('Discard unsaved changes to this draft?'); }
  function create(event: FormEvent) { event.preventDefault(); if (!discardAllowed()) return; void perform(async () => { const row = await api<Draft>(`/projects/${projectId}/${kind}s`, { method: 'POST', body: { name } }); accept(row); setName(''); setList(await api(`/projects/${projectId}/${kind}s`)); }); }
  function open(id: string) { if (!discardAllowed()) return; void perform(async () => { accept(await api<Draft>(`/${kind}s/${id}`)); await loadRevisions(id); }); }
  async function save() { setComparison(null); if (!draft || !document) return; const row = await api<Draft>(`/${kind}s/${draft.id}`, { method: 'PUT', headers: { 'If-Match': `"${draft.revision}"` }, body: { name: draft.name, document } }); setDraft(row); setMessage(`Saved revision ${row.revision}`); setList(await api(`/projects/${projectId}/${kind}s`)); }
  async function loadRevisions(id: string, before?: number) {
    const result = await api<{ items: Array<{ revision: number; checksum: string }>; nextBefore: number | null }>(`/${kind}s/${id}/revisions${before ? `?before=${before}` : ''}`);
    setRevisions((prior) => before ? [...prior, ...result.items.filter((item) => !prior.some((old) => old.revision === item.revision))] : result.items); setNextBefore(result.nextBefore);
  }
  async function compare(revision: number) {
    if (!draft) return;
    setComparison(await api(`/${kind}s/${draft.id}/revisions/${revision}/compare?target=${compareTarget}`, { headers: { 'If-Match': `"${draft.revision}"` } }));
  }
  async function restore(revision: number) {
    if (!draft || !comparison || comparison.baseRevision !== revision || comparison.target !== 'draft' || comparison.targetRevision !== draft.revision) return;
    const epoch = editEpoch.current;
    const row = await api<Draft>(`/${kind}s/${draft.id}/restore`, { method: 'POST', headers: { 'If-Match': `"${draft.revision}"` }, body: { revision, reason: restoreReason } });
    const edited = epoch !== editEpoch.current;
    if (!edited) accept(row);
    else { setDraft(row); setComparison(null); }
    setMessage(`Restored revision ${revision} as draft ${row.revision}${edited ? ' · local edits retained' : ''}`);
    await loadRevisions(row.id); setList(await api(`/projects/${projectId}/${kind}s`));
  }
  function undo(redo = false) { editEpoch.current++; setComparison(null); setDocument(redo ? history.current!.redo() : history.current!.undo()); setMessage(''); setSimulation(null); }
  function addBlock() {
    const graph = document as LogicGraph; const signal = blockKind === 'output' ? outputSignal : available.find((s) => s.dataType === (blockKind === 'analog' ? 'float64' : 'boolean'));
    if (['input', 'analog', 'output'].includes(blockKind) && !signal) { setError(blockKind === 'analog' ? 'Register a virtual thermal process to create a numeric input.' : 'Add a compatible device signal first.'); return; }
    if (blockKind === 'script' && graph.nodes.filter((node) => node.kind === 'script').length >= 2) { setError('This profile supports at most two script blocks per graph.'); return; }
    const node: LogicNode = { id: crypto.randomUUID(), kind: blockKind, label: labels[blockKind], x: 80 + (graph.nodes.length % 4) * 220, y: 80 + Math.floor(graph.nodes.length / 4) * 130,
      ...(blockKind === 'script' ? { source: 'return input.a && !input.b;', language: 'typescript' as const } : {}), ...(blockKind === 'constant' ? { value: false } : {}), ...(blockKind === 'number' ? { value: 0 } : {}), ...(blockKind === 'hysteresis' ? { low: 0, high: 1 } : {}), ...(blockKind === 'filter' ? { timeConstantMs: 1000 } : {}), ...(blockKind === 'counter' ? { maxCount: 1000000 } : {}), ...(blockKind === 'pid' ? { pid: { kp: 0.1, ki: 0.01, kd: 0, derivativeMs: 100, maxIntervalMs: 2500 } } : {}), ...(blockKind === 'schedule' ? { schedule: { zone: 'UTC', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 } } : {}), ...(blockKind === 'pwm' ? { windowMs: 2000 } : {}), ...(timed.has(blockKind) ? { delayMs: 1000 } : {}), ...(['input', 'analog', 'output'].includes(blockKind) ? { signalId: signal!.id } : {}) };
    edit({ ...graph, nodes: [...graph.nodes, node] }); setSelected(node.id);
  }
  function template() {
    if (!outputSignal) { setError('Register a device in this project before using the LED template.'); return; }
    if ((document as LogicGraph).nodes.length && !window.confirm('Replace this draft with the LED template?')) return;
    edit({ schemaVersion: 1, nodes: [{ id: 'power', kind: 'constant', label: 'Power', value: false, x: 90, y: 160 }, { id: 'led', kind: 'output', label: 'LED', signalId: outputSignal.id, x: 410, y: 160 }], edges: [{ id: 'power-led', source: 'power', target: 'led', port: 'in' }] });
  }
  function thermostatTemplate() {
    const device = templateDevice;
    const temperature = available.find((s) => s.deviceId === device?.id && s.dataType === 'float64' && s.direction === 'input');
    const heater = available.find((s) => s.deviceId === device?.id && s.dataType === 'boolean' && s.direction === 'output');
    if (!temperature || !heater) { setError('Register a virtual thermal process in this project first.'); return; }
    if ((document as LogicGraph).nodes.length && !window.confirm('Replace this draft with the thermostat template?')) return;
    edit({ schemaVersion: 1, nodes: [
      { id: 'temperature', kind: 'analog', label: 'Temperature', signalId: temperature.id, x: 40, y: 120 },
      { id: 'warm', kind: 'hysteresis', label: 'Warm', low: 23, high: 24, x: 300, y: 120 },
      { id: 'heat', kind: 'not', label: 'Heating demand', x: 560, y: 120 },
      { id: 'heater', kind: 'output', label: 'Heater', signalId: heater.id, x: 820, y: 120 },
    ], edges: [{ id: 't-w', source: 'temperature', target: 'warm', port: 'in' }, { id: 'w-h', source: 'warm', target: 'heat', port: 'in' }, { id: 'h-o', source: 'heat', target: 'heater', port: 'in' }] });
    setSelected('temperature');
  }
  function pidTemplate() {
    const temperature = available.find((s) => s.deviceId === templateDevice?.id && s.dataType === 'float64' && s.direction === 'input');
    const heater = available.find((s) => s.deviceId === templateDevice?.id && s.dataType === 'boolean' && s.direction === 'output');
    if (!temperature || !heater) { setError('Register a virtual thermal process in this project first.'); return; }
    if ((document as LogicGraph).nodes.length && !window.confirm('Replace this draft with the PID thermostat template?')) return;
    edit(pidThermostatGraph(temperature.id, heater.id)); setSelected('pid');
  }
  function addItem(itemKind: ScreenItem['kind']) {
    const binding = itemKind === 'value' ? available.find((s) => s.dataType === 'float64') : outputSignal;
    if (['indicator', 'button', 'value'].includes(itemKind) && !binding) { setError('Register a device signal before adding a bound element.'); return; }
    const scene = document as Screen;
    const item: ScreenItem = { id: crypto.randomUUID(), kind: itemKind, label: itemKind[0]!.toUpperCase() + itemKind.slice(1), x: 40 + (scene.items.length % 4) * 200, y: 60 + Math.floor(scene.items.length / 4) * 130, width: itemKind === 'group' ? 400 : 170, height: itemKind === 'group' ? 240 : 90,
      ...(['indicator', 'button', 'value'].includes(itemKind) ? { signalId: binding!.id } : {}) };
    edit({ ...scene, items: [...scene.items, item] }); setSelected(item.id);
  }
  function update(changes: Partial<Omit<LogicNode, 'kind'> & Omit<ScreenItem, 'kind'>>) {
    if (kind === 'graph') { const graph = document as LogicGraph; edit({ ...graph, nodes: graph.nodes.map((n) => n.id === selected ? { ...n, ...changes } : n) }); }
    else { const screen = document as Screen; edit({ ...screen, items: screen.items.map((n) => n.id === selected ? { ...n, ...changes } : n) }); }
  }
  function remove() {
    if (kind === 'graph') { const graph = document as LogicGraph; edit({ ...graph, nodes: graph.nodes.filter((n) => n.id !== selected), edges: graph.edges.filter((e) => e.source !== selected && e.target !== selected) }); }
    else { const screen = document as Screen; edit({ ...screen, items: screen.items.filter((n) => n.id !== selected).map((n) => { if (n.groupId !== selected) return n; const copy = { ...n }; delete copy.groupId; return copy; }) }); }
    setSelected('');
  }
  const selectedItem = document && (kind === 'graph' ? (document as LogicGraph).nodes : (document as Screen).items).find((n) => n.id === selected);
  if (operator) return <ScreenOperator screen={operator.document} revision={operator.revision} projectRevision={projects.find((p) => p.id === projectId)?.revision ?? 0} close={() => setOperator(null)} />;
  return <div className="engineering">
    <section className="panel scheme-browser"><div className="scheme-browser-heading"><Field label="Editor project"><select disabled={busy} value={projectId} onChange={(e) => { if (discardAllowed()) { setProjectId(e.target.value); setDraft(null); setDocument(null); } }}>{projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field><form onSubmit={create}><Field label="Scheme name"><input required maxLength={128} value={name} placeholder={kind === 'graph' ? 'e.g. LED automation' : 'e.g. Operator overview'} onChange={(e) => setName(e.target.value)} /></Field><button className="primary" disabled={busy || !projectId}>Create {kind}</button></form></div><div className="scheme-tabs">{list.items.map((item) => <button disabled={busy} key={item.id} className={draft?.id === item.id ? 'scheme-tab selected' : 'scheme-tab'} aria-label={`Open ${item.name}`} onClick={() => open(item.id)}>{item.name}<small>r{item.revision}</small></button>)}{list.nextCursor && <button className="secondary" onClick={() => { void perform(async () => { const next = await api<Page<Draft>>(`/projects/${projectId}/${kind}s?cursor=${list.nextCursor}`); setList({ items: [...list.items, ...next.items], nextCursor: next.nextCursor }); }); }}>More schemes</button>}</div></section>
    {error && <div role="alert" className="alert">{error}</div>}{message && <div role="status" className="editor-message">{message}</div>}
    {!draft || !document ? <section className="panel empty"><h2>{kind === 'graph' ? 'Build the logic behind your process.' : 'Give your process a clear visual home.'}</h2><p>Create a {kind} above, or open a saved draft.</p></section> : <>
      <div className="editor-toolbar"><div><strong>{draft.name}</strong><span className="badge warning">Draft r{draft.revision}{dirty ? ' · Unsaved' : ''}</span><span className="badge good">Simulation</span></div><div><button className="secondary" aria-label="Undo" disabled={!history.current?.canUndo} onClick={() => undo()}>↶</button><button className="secondary" aria-label="Redo" disabled={!history.current?.canRedo} onClick={() => undo(true)}>↷</button><button className="secondary" onClick={() => { setText(JSON.stringify(document, null, 2)); setTextMode(!textMode); }}>JSON</button><button className="primary" disabled={busy || !dirty} onClick={() => { void perform(save); }}>Save draft</button><button className="secondary" disabled={busy || dirty} onClick={() => { void perform(async () => { await api(`/${kind}s/${draft.id}/revisions`, { method: 'POST', headers: { 'If-Match': `"${draft.revision}"` } }); setMessage(`Revision ${draft.revision} prepared`); await loadRevisions(draft.id); }); }}>Prepare revision</button></div></div>
      {textMode ? <section className="panel json-editor"><Field label="JSON document"><textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} /></Field><button className="primary" onClick={() => { try { edit(kind === 'graph' ? validateGraph(JSON.parse(text), false) : validateScreen(JSON.parse(text))); setTextMode(false); } catch (reason) { setError(String(reason)); } }}>Apply JSON</button></section> : <div className="editor-grid"><section className="panel canvas-panel"><div className="canvas-tools">{kind === 'graph' ? <><select aria-label="Block type" value={blockKind} onChange={(e) => setBlockKind(e.target.value as BlockKind)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="secondary" onClick={addBlock}>Add block</button><button className="text-button" onClick={template}>LED template</button><select aria-label="Template device" value={templateDevice?.id ?? ''} disabled={!thermalDevices.length} onChange={(e) => setThermalDeviceId(e.target.value)}>{thermalDevices.length ? thermalDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>) : <option value="">No thermal devices</option>}</select><button className="text-button" onClick={thermostatTemplate}>Thermostat template</button><button className="text-button" onClick={pidTemplate}>PID thermostat template</button></> : <>{(['label', 'indicator', 'value', 'button', 'group'] as const).map((item) => <button className="secondary" key={item} onClick={() => addItem(item)}>Add {item}</button>)}</>}</div>
        {kind === 'graph' ? <GraphCanvas graph={document as LogicGraph} selected={selected} select={setSelected} edit={edit} onError={setError} result={simulation} /> : <ScreenCanvas screen={document as Screen} selected={selected} select={setSelected} edit={edit} />}
        <div className="canvas-footer">{kind === 'graph' ? 'Connect matching types: number or boolean. Timers use monotonic time.' : 'Drag elements or use arrow keys. Hold Shift for 1 px movement.'}</div></section>
        <aside className="panel inspector"><div className="panel-heading"><h2>Properties</h2></div>{selectedItem ? <div className="inspector-fields"><span className="eyebrow">{selectedItem.kind}</span><Field label={kind === 'graph' ? 'Block label' : 'Element label'}><input maxLength={128} value={selectedItem.label} onChange={(e) => update({ label: e.target.value })} /></Field>
          <div className="coordinate-fields">{(['x', 'y'] as const).map((axis) => <Field key={axis} label={axis.toUpperCase()}><input type="number" min={-100000} max={100000} value={selectedItem[axis]} onChange={(e) => update({ [axis]: Number(e.target.value) })} /></Field>)}</div>
          {'signalId' in selectedItem && <Field label="Signal binding"><select value={selectedItem.signalId} onChange={(e) => update({ signalId: e.target.value })}>{available.filter((s) => s.dataType === (['analog', 'value'].includes(selectedItem.kind) ? 'float64' : 'boolean') && (!['button', 'output'].includes(selectedItem.kind) || s.direction === 'output')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
          {selectedItem.kind === 'constant' && <label className="checkbox-field"><input aria-label="Constant value" type="checkbox" checked={(selectedItem as LogicNode).value === true} onChange={(e) => update({ value: e.target.checked })} />Constant value (ON)</label>}
          {selectedItem.kind === 'number' && <Field label="Numeric value"><input aria-label="Numeric value" type="number" step="any" value={typeof selectedItem.value === 'number' ? selectedItem.value : ''} onChange={(e) => update({ value: e.target.valueAsNumber })} /></Field>}
          {selectedItem.kind === 'hysteresis' && <><Field label="Low threshold"><input aria-label="Low threshold" type="number" step="any" value={selectedItem.low} onChange={(e) => update({ low: e.target.valueAsNumber })} /></Field><Field label="High threshold"><input aria-label="High threshold" type="number" step="any" value={selectedItem.high} onChange={(e) => update({ high: e.target.valueAsNumber })} /></Field><p className="muted">ON at or above high; OFF at or below low. Between thresholds, keep the previous state. Starts OFF and resets on invalid input.</p></>}
          {selectedItem.kind === 'filter' && <><Field label="Time constant (ms)"><input aria-label="Time constant (ms)" type="number" min={1} max={86400000} step={1} value={selectedItem.timeConstantMs} onChange={(e) => update({ timeConstantMs: e.target.valueAsNumber })} /></Field><p className="muted">Smooths using elapsed time. The first valid sample initializes the filter. Invalid input and revision activation reset its state.</p></>}
          {selectedItem.kind === 'counter' && <><Field label="Counter limit"><input aria-label="Counter limit" type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={selectedItem.maxCount} onChange={(e) => update({ maxCount: e.target.valueAsNumber })} /></Field><p className="muted">Counts observed OFF to ON transitions and holds at the limit. Reset has priority. Starts at zero; an initial ON does not count. Invalid input and revision activation reset the count.</p></>}
          {selectedItem.kind === 'pid' && <>{([['kp', 'Proportional gain (Kp)'], ['ki', 'Integral gain (Ki)'], ['kd', 'Derivative gain (Kd)'], ['derivativeMs', 'Derivative filter (ms)'], ['maxIntervalMs', 'Maximum interval (ms)']] as const).map(([key, label]) => <Field key={key} label={label}><input aria-label={label} type="number" min={key === 'derivativeMs' ? 1 : key === 'maxIntervalMs' ? 100 : 0} max={key.endsWith('Ms') ? 60000 : undefined} step={key.endsWith('Ms') ? 1 : 'any'} value={selectedItem.pid![key]} onChange={(e) => update({ pid: { ...selectedItem.pid!, [key]: e.target.valueAsNumber } })} /></Field>)}<p className="muted">Output is 0 to 1. Manual duty must use the same range. Manual to Auto tracks the previous output. Disable or Reset yields zero; invalid input or overdue calculation faults the graph. Tune for the selected process before activation.</p></>}
          {selectedItem.kind === 'schedule' && <>
            <Field label="Time zone"><input aria-label="Time zone" maxLength={64} value={selectedItem.schedule!.zone} onChange={(e) => update({ schedule: { ...selectedItem.schedule!, zone: e.target.value } })} /></Field>
            {([['startMinute', 'Start time'], ['endMinute', 'End time']] as const).map(([key, label]) => <Field key={key} label={label}><input aria-label={label} type="time" step={60} value={`${String(Math.floor(selectedItem.schedule![key] / 60)).padStart(2, '0')}:${String(selectedItem.schedule![key] % 60).padStart(2, '0')}`} onChange={(e) => { const [hours, minutes] = e.target.value.split(':').map(Number); if (hours !== undefined && minutes !== undefined) update({ schedule: { ...selectedItem.schedule!, [key]: hours * 60 + minutes } }); }} /></Field>)}
            <fieldset className="schedule-days"><legend>Window start days</legend>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, i) => <label className="checkbox-field" key={day}><input type="checkbox" checked={selectedItem.schedule!.days.includes(i + 1)} onChange={(e) => update({ schedule: { ...selectedItem.schedule!, days: e.target.checked ? [...selectedItem.schedule!.days, i + 1].sort() : selectedItem.schedule!.days.filter((d) => d !== i + 1) } })} />{day}</label>)}</fieldset>
            <p className="muted">End before start crosses midnight; equal times mean a full day. Missing DST boundaries skip the window; repeated boundaries use the first occurrence. Missed windows never replay. A clock divergence above 1 second faults the graph until reactivation.</p>
          </>}
          {selectedItem.kind === 'pwm' && <><Field label="Window (ms)"><input aria-label="Window (ms)" type="number" min={1000} max={60000} step={1} value={selectedItem.windowMs} onChange={(e) => update({ windowMs: e.target.valueAsNumber })} /></Field><p className="muted">Holds a 0 to 1 duty for each window. Zero immediately cancels ON time. Resolution depends on graph and command timing; this is not hardware PWM.</p></>}
          {selectedItem.kind === 'analog' && <p className="muted">Virtual thermal inputs can run live. Physical numeric sensor drivers are not available in this profile.</p>}
          {selectedItem.kind === 'script' && <div className="script-editor"><Field label="Script language"><select aria-label="Script language" value={selectedItem.language} onChange={(e) => update({ language: e.target.value as 'javascript' | 'typescript' })}><option value="typescript">TypeScript</option><option value="javascript">JavaScript</option></select></Field><Field label="Script source"><textarea aria-label="Script source" spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={12} maxLength={16384} value={selectedItem.source} onChange={(e) => update({ source: e.target.value })} /></Field><p className="muted">Use input.a, input.b and nowMs. Return a boolean. Each call starts fresh; no network or device access. Script graphs run at most once per second.</p></div>}
          {'delayMs' in selectedItem && <Field label="Delay (ms)"><input type="number" min={0} max={86400000} value={selectedItem.delayMs} onChange={(e) => update({ delayMs: Number(e.target.value) })} /></Field>}
          {kind === 'screen' && <><div className="coordinate-fields">{(['width', 'height'] as const).map((axis) => <Field key={axis} label={axis === 'width' ? 'Width' : 'Height'}><input type="number" min={1} max={10000} value={(selectedItem as ScreenItem)[axis]} onChange={(e) => update({ [axis]: Number(e.target.value) })} /></Field>)}</div><Field label="Parent group"><select value={(selectedItem as ScreenItem).groupId ?? ''} onChange={(e) => { const scene = document as Screen; const next = { ...scene, items: scene.items.map((n) => { if (n.id !== selected) return n; const copy = { ...n }; if (e.target.value) copy.groupId = e.target.value; else delete copy.groupId; return copy; }) }; try { edit(validateScreen(next)); } catch (reason) { setError(String(reason)); } }}>{[<option key="none" value="">None</option>, ...(document as Screen).items.filter((i) => i.kind === 'group' && i.id !== selected).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)]}</select></Field></>}
          <button className="secondary danger-text" onClick={remove}>Delete selected</button></div> : <div className="inspector-empty">Select an element to edit its properties.</div>}</aside></div>}
      {kind === 'graph' && <section className="panel simulation-panel"><div><h2>Simulation bench</h2><p className="muted">Run the saved draft for 5 seconds in virtual time. No physical commands are sent.</p></div><div className="simulation-inputs">{(document as LogicGraph).nodes.some((n) => n.kind === 'schedule') && <Field label="Simulation start (UTC)"><input aria-label="Simulation start (UTC)" type="datetime-local" min="1900-01-01T00:00" max="2100-12-31T23:59" value={simStart} onChange={(e) => { setSimStart(e.target.value); setSimulation(null); }} /></Field>}{(document as LogicGraph).nodes.filter((n) => n.kind === 'input' || n.kind === 'analog').map((n) => n.kind === 'analog' ? <div key={n.id}><Field label={`Simulate ${n.label}`}><input aria-label={`Simulate ${n.label}`} type="number" step="any" disabled={simInputs[n.signalId!] === null} value={typeof simInputs[n.signalId!] === 'number' ? simInputs[n.signalId!] as number : 0} onChange={(e) => setSimInputs({ ...simInputs, [n.signalId!]: Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null })} /></Field><label className="checkbox-field"><input type="checkbox" checked={simInputs[n.signalId!] === null} onChange={(e) => setSimInputs({ ...simInputs, [n.signalId!]: e.target.checked ? null : 0 })} />{n.label} disconnected</label></div> : <Field key={n.id} label={`Simulate ${n.label}`}><select value={simInputs[n.signalId!] === null ? 'bad' : simInputs[n.signalId!] ? 'on' : 'off'} onChange={(e) => setSimInputs({ ...simInputs, [n.signalId!]: e.target.value === 'bad' ? null : e.target.value === 'on' })}><option value="off">OFF</option><option value="on">ON</option><option value="bad">Disconnected</option></select></Field>)}</div><button className="primary" disabled={busy || dirty} onClick={() => { void perform(async () => {
        const inputs = Object.fromEntries((document as LogicGraph).nodes.filter((n) => n.kind === 'input' || n.kind === 'analog').map((n) => [n.signalId!, Object.hasOwn(simInputs, n.signalId!) ? simInputs[n.signalId!] : n.kind === 'analog' ? 0 : false]));
        const scripted = (document as LogicGraph).nodes.some((node) => node.kind === 'script');
        const scheduled = (document as LogicGraph).nodes.some((n) => n.kind === 'schedule');
        if (scheduled && !simStart) throw new Error('Choose the simulation start in UTC');
        const result = await api<{ steps: LogicResult[] }>(`/graphs/${draft.id}/simulate`, { method: 'POST', body: { ...(scheduled ? { startAt: new Date(`${simStart}Z`).toISOString() } : {}), steps: Array.from({ length: scripted ? 6 : 51 }, (_, i) => ({ atMs: i * (scripted ? 1000 : 100), inputs })) } }); setSimulation(result.steps.at(-1)!);
      }); }}>Run simulation</button>{simulation && <div role="status" aria-label="Simulation result" className="simulation-result">{Object.entries(simulation.outputs).map(([id, value]) => <span key={id}><strong>{available.find((s) => s.id === id)?.name ?? id}</strong><span className={`badge ${value.quality === 'Good' ? 'good' : 'warning'}`}>{value.value === null ? 'No output' : displayValue(value.value)}</span>{value.reason && <small>{value.reason}</small>}</span>)}{!Object.keys(simulation.outputs).length && <span>Graph evaluated; no output blocks configured.</span>}</div>}</section>}
      {kind === 'graph' && <GraphRuntimePanel key={draft.id} id={draft.id} revisions={revisions.map((r) => r.revision)} dirty={dirty} />}
      {!!revisions.length && <section className="panel revision-list"><h2>Prepared revisions</h2><p className="muted">Restore a reviewed snapshot to a new draft. Running equipment keeps its active revision. Prepare any draft you need to preserve before replacing it.</p>
        <label className="field"><span>Compare against</span><select aria-label="Compare against" disabled={busy} value={compareTarget} onChange={(event) => { setCompareTarget(event.target.value); setComparison(null); }}><option value="draft">Saved draft r{draft.revision}</option>{revisions.map((revision) => <option key={revision.revision} value={revision.revision}>Prepared revision {revision.revision}</option>)}</select></label>
        <label className="field"><span>Restore reason</span><input maxLength={256} disabled={busy} value={restoreReason} onChange={(event) => setRestoreReason(event.target.value)} /></label>
        {revisions.map((r) => <div className="revision-row" key={r.revision}><span>Revision {r.revision}</span><code>{r.checksum.slice(0, 16)}</code>
          <button className="secondary" disabled={busy || dirty} onClick={() => { void perform(() => compare(r.revision)); }}>Compare revision {r.revision}</button>
          <button className="secondary" disabled={busy || dirty || !restoreReason.trim() || comparison?.baseRevision !== r.revision || comparison.target !== 'draft' || comparison.targetRevision !== draft.revision} onClick={() => { void perform(() => restore(r.revision)); }}>Restore revision {r.revision} to draft</button>
          {kind === 'screen' && <button className="secondary" disabled={busy || dirty} onClick={() => { void perform(async () => { const found = await api<{ items: Array<{ revision: number; document: Screen }> }>(`/screens/${draft.id}/revisions?before=${r.revision + 1}`); const saved = found.items.find((item) => item.revision === r.revision); if (!saved) throw new Error('Prepared screen not found'); setOperator({ revision: saved.revision, document: validateScreen(saved.document) }); }); }}>Operate revision {r.revision}</button>}
        </div>)}
        {nextBefore && <button className="secondary" disabled={busy} onClick={() => { void perform(() => loadRevisions(draft.id, nextBefore)); }}>Older prepared revisions</button>}
        {comparison && <><p role="status">Revision {comparison.baseRevision} → {comparison.target} r{comparison.targetRevision}: {comparison.total} changes{comparison.truncated ? ' · showing the first 200' : ''}</p><div className="table-scroll"><table aria-label="Revision changes"><thead><tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr></thead><tbody>{comparison.changes.map((change) => <tr key={change.path}><td><code>{change.path || '/'}</code></td><td>{change.kind}</td><td><pre>{Object.hasOwn(change, 'before') ? JSON.stringify(change.before, null, 2) : 'Absent'}</pre></td><td><pre>{Object.hasOwn(change, 'after') ? JSON.stringify(change.after, null, 2) : 'Absent'}</pre></td></tr>)}</tbody></table></div></>}
      </section>}

    </>}
  </div>;
}

type FlowBlock = Node<{ item: LogicNode; select: (id: string) => void; result?: string }, 'block'>;
function BlockView({ data, selected }: NodeProps<FlowBlock>) {
  const item = data.item;
  return <div className={`logic-block ${ports[item.kind].length > 4 ? 'multi-port' : ''} ${selected ? 'selected' : ''}`}><span className="block-kind">{labels[item.kind]}</span><button className="block-title nodrag" aria-label={`Select ${item.label}`} onClick={() => data.select(item.id)}>{item.label}</button><span className="block-value">{data.result ?? (item.kind === 'constant' || item.kind === 'number' ? displayValue(item.value!) : timed.has(item.kind) ? `${item.delayMs} ms` : outputType(item.kind) === 'number' ? 'Number' : 'Boolean')}</span>
    {ports[item.kind].map((port, i, all) => <Handle key={port} type="target" position={Position.Left} id={port} style={{ top: `${((i + 1) / (all.length + 1)) * 100}%` }} aria-label={`Input ${port}`} title={`${port}: ${portType(item.kind, port)}`}><span className="port-label">{port}</span></Handle>)}{item.kind !== 'output' && <Handle type="source" position={Position.Right} id="out" aria-label="Output" title={`Output: ${outputType(item.kind)}`} />}</div>;
}
const nodeTypes = { block: BlockView };
function GraphCanvas({ graph, selected, select, edit, onError, result }: { graph: LogicGraph; selected: string; select: (id: string) => void; edit: (value: Document) => void; onError: (message: string) => void; result: LogicResult | null }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowBlock>([]);
  const [source, setSource] = useState(''); const [target, setTarget] = useState(''); const [port, setPort] = useState('');
  useEffect(() => { setNodes(graph.nodes.map((n) => ({ id: n.id, type: 'block', deletable: false, position: { x: n.x, y: n.y }, selected: n.id === selected, data: { item: n, select, ...(result?.nodes[n.id] ? { result: displayValue(result.nodes[n.id]!.value) } : {}) } }))); }, [graph, selected, select, result, setNodes]);
  function connect(connection: Pick<Connection, 'source' | 'target' | 'targetHandle'>) {
    if (!connection.source || !connection.target || !connection.targetHandle) return;
    const next = { ...graph, edges: [...graph.edges, { id: crypto.randomUUID(), source: connection.source, target: connection.target, port: connection.targetHandle }] };
    try { edit(validateGraph(next, false)); onError(''); } catch (reason) { onError(String(reason)); }
  }
  return <><div className="graph-canvas"><ReactFlow nodes={nodes} edges={graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: 'out', targetHandle: e.port, type: 'smoothstep' }))} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeClick={(_, n) => select(n.id)} onNodeDragStop={(_, n) => edit({ ...graph, nodes: graph.nodes.map((item) => item.id === n.id ? { ...item, x: Math.round(n.position.x), y: Math.round(n.position.y) } : item) })} onConnect={connect} onEdgesDelete={(deleted) => edit({ ...graph, edges: graph.edges.filter((e) => !deleted.some((d) => d.id === e.id)) })} fitView minZoom={0.2} maxZoom={2} colorMode="system"><Background color="var(--border)" gap={24} /><Controls showInteractive={false} /></ReactFlow></div>
    <details className="connection-form"><summary>Connections · keyboard and touch</summary><div><select aria-label="Connection source" value={source} onChange={(e) => setSource(e.target.value)}><option value="">Source block</option>{graph.nodes.filter((n) => n.kind !== 'output').map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</select><select aria-label="Connection target" value={target} onChange={(e) => { setTarget(e.target.value); setPort(''); }}><option value="">Target block</option>{graph.nodes.filter((n) => ports[n.kind].length).map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</select><select aria-label="Connection port" value={port} onChange={(e) => setPort(e.target.value)}><option value="">Input port</option>{ports[graph.nodes.find((n) => n.id === target)?.kind ?? 'constant'].map((p) => <option key={p}>{p}</option>)}</select><button className="secondary" disabled={!source || !target || !port} onClick={() => connect({ source, target, targetHandle: port })}>Connect</button></div>{graph.edges.map((e) => <div className="connection-row" key={e.id}><span>{graph.nodes.find((n) => n.id === e.source)?.label} → {graph.nodes.find((n) => n.id === e.target)?.label}.{e.port}</span><button className="text-button" aria-label={`Remove connection ${e.id}`} onClick={() => edit({ ...graph, edges: graph.edges.filter((edge) => edge.id !== e.id) })}>Remove</button></div>)}</details></>;
}
function ScreenCanvas({ screen, selected, select, edit }: { screen: Screen; selected: string; select: (id: string) => void; edit: (value: Document) => void }) {
  const drag = useRef<{ id: string; x: number; y: number } | null>(null); const [offset, setOffset] = useState({ x: 0, y: 0 });
  function members(id: string) { const ids = new Set([id]); let added = true; while (added) { added = false; for (const n of screen.items) if (n.groupId && ids.has(n.groupId) && !ids.has(n.id)) { ids.add(n.id); added = true; } } return ids; }
  function move(id: string, x: number, y: number) { const ids = members(id); edit({ ...screen, items: screen.items.map((n) => ids.has(n.id) ? { ...n, x: Math.max(-100000, Math.min(100000, n.x + x)), y: Math.max(-100000, Math.min(100000, n.y + y)) } : n) }); }
  function point(event: React.PointerEvent<SVGGElement>) { const svg = event.currentTarget.ownerSVGElement!; const matrix = svg.getScreenCTM()!; return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); }
  const moving = drag.current ? members(drag.current.id) : new Set<string>();
  return <div className="screen-canvas"><svg viewBox={`0 0 ${screen.width} ${screen.height}`} aria-label="HMI design canvas" role="group"><defs><pattern id="hmi-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--border)" /></pattern></defs><rect width="100%" height="100%" fill="url(#hmi-grid)" />{[...screen.items].sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group')).map((item) => <g key={item.id} role="button" tabIndex={0} aria-label={`Select ${item.label}`} aria-pressed={selected === item.id} className={`screen-item ${item.kind} ${selected === item.id ? 'selected' : ''}`} transform={`translate(${item.x + (moving.has(item.id) ? offset.x : 0)},${item.y + (moving.has(item.id) ? offset.y : 0)})`} onClick={() => select(item.id)}
      onPointerDown={(event) => { if (event.button !== 0) return; select(item.id); const p = point(event); drag.current = { id: item.id, x: p.x, y: p.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (!drag.current || drag.current.id !== item.id) return; const p = point(event); setOffset({ x: Math.round(p.x - drag.current.x), y: Math.round(p.y - drag.current.y) }); }}
      onPointerUp={(event) => { if (!drag.current || drag.current.id !== item.id) return; const p = point(event); const start = drag.current; drag.current = null; setOffset({ x: 0, y: 0 }); move(item.id, Math.round(p.x - start.x), Math.round(p.y - start.y)); }}
      onPointerCancel={() => { drag.current = null; setOffset({ x: 0, y: 0 }); }}
      onKeyDown={(event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(item.id); } const delta = event.shiftKey ? 1 : 10; const offsets: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] }; const next = offsets[event.key]; if (next) { event.preventDefault(); move(item.id, ...next); } }}>
      <rect width={item.width} height={item.height} rx={item.kind === 'group' ? 12 : 8} />{item.kind === 'indicator' && <circle cx={22} cy={item.height / 2} r={8} className="unknown-lamp" />}<text x={item.kind === 'indicator' ? 42 : 14} y={item.kind === 'group' ? 26 : item.height / 2 - (['indicator', 'value'].includes(item.kind) ? 4 : -5)}>{item.label}</text>{['indicator', 'value'].includes(item.kind) && <text x={item.kind === 'indicator' ? 42 : 14} y={item.height / 2 + 17} className="hmi-quality">No live data</text>}{item.kind === 'button' && <text x={14} y={item.height - 12} className="hmi-quality">Design only</text>}</g>)}</svg></div>;
}
