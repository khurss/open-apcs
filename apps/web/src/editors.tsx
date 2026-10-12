import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, useNodesState, type Connection, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ports, validateGraph, type BlockKind, type LogicGraph, type LogicNode, type LogicResult } from '../../../packages/domain/src/logic.js';
import { canonicalJson, EditHistory, validateScreen, type Screen, type ScreenItem } from '../../../packages/domain/src/screen.js';
import { api, type Project, type Device, type Signal, type Page } from './api.js';
import './editors.css';

type Document = LogicGraph | Screen;
type Kind = 'graph' | 'screen';
interface Draft { id: string; projectId: string; name: string; revision: number; document: Document; }
interface Props { kind: Kind; projects: Project[]; devices: Device[]; signals: Signal[]; initialProject: string; onDirty: (dirty: boolean) => void; }
const labels: Record<BlockKind, string> = { constant: 'Constant', input: 'Input', output: 'Output', not: 'NOT', and: 'AND', or: 'OR', xor: 'XOR', ton: 'On-delay', tof: 'Off-delay', pulse: 'Pulse', debounce: 'Debounce', latch: 'Latch', interlock: 'Interlock', mode: 'Auto / Manual' };
const timed = new Set<BlockKind>(['ton', 'tof', 'pulse', 'debounce']);
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
  const [simulation, setSimulation] = useState<LogicResult | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState('');
  const [simInputs, setSimInputs] = useState<Record<string, boolean | null>>({});
  const [revisions, setRevisions] = useState<Array<{ revision: number; checksum: string }>>([]);
  const [blockKind, setBlockKind] = useState<BlockKind>('constant');
  const dirty = !!draft && canonicalJson(document) !== canonicalJson(draft.document);
  const available = signals.filter((s) => devices.some((d) => d.id === s.deviceId && d.projectId === projectId));
  const outputSignal = available.find((s) => s.direction === 'output');
  useEffect(() => { if (!projectId && projects.length) setProjectId(initialProject || projects[0]!.id); }, [projectId, projects, initialProject]);
  useEffect(() => { onDirty(dirty); const prevent = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', prevent); return () => { onDirty(false); window.removeEventListener('beforeunload', prevent); }; }, [dirty, onDirty]);
  useEffect(() => {
    let active = true;
    if (projectId) void api<Page<Draft>>(`/projects/${projectId}/${kind}s`).then((items) => { if (active) setList(items); }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [projectId, kind]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Operation failed'); } finally { setBusy(false); } }
  function accept(row: Draft) { setDraft(row); setDocument(row.document); history.current = new EditHistory(row.document); setSelected(''); setSimulation(null); setTextMode(false); setSimInputs({}); setRevisions([]); }
  function edit(next: Document) { history.current!.set(next); setDocument(history.current!.current); setMessage(''); setSimulation(null); }
  function discardAllowed() { return !dirty || window.confirm('Discard unsaved changes to this draft?'); }
  function create(event: FormEvent) { event.preventDefault(); if (!discardAllowed()) return; void perform(async () => { const row = await api<Draft>(`/projects/${projectId}/${kind}s`, { method: 'POST', body: { name } }); accept(row); setName(''); setList(await api(`/projects/${projectId}/${kind}s`)); }); }
  function open(id: string) { if (!discardAllowed()) return; void perform(async () => { accept(await api<Draft>(`/${kind}s/${id}`)); }); }
  async function save() { if (!draft || !document) return; const row = await api<Draft>(`/${kind}s/${draft.id}`, { method: 'PUT', headers: { 'If-Match': `"${draft.revision}"` }, body: { name: draft.name, document } }); setDraft(row); setMessage(`Saved revision ${row.revision}`); setList(await api(`/projects/${projectId}/${kind}s`)); }
  function undo(redo = false) { setDocument(redo ? history.current!.redo() : history.current!.undo()); setMessage(''); setSimulation(null); }
  function addBlock() {
    const graph = document as LogicGraph; const signal = blockKind === 'output' ? outputSignal : available[0];
    if (['input', 'output'].includes(blockKind) && !signal) { setError('Add a compatible device signal first.'); return; }
    const node: LogicNode = { id: crypto.randomUUID(), kind: blockKind, label: labels[blockKind], x: 80 + (graph.nodes.length % 4) * 220, y: 80 + Math.floor(graph.nodes.length / 4) * 130,
      ...(blockKind === 'constant' ? { value: false } : {}), ...(timed.has(blockKind) ? { delayMs: 1000 } : {}), ...(['input', 'output'].includes(blockKind) ? { signalId: signal!.id } : {}) };
    edit({ ...graph, nodes: [...graph.nodes, node] }); setSelected(node.id);
  }
  function template() {
    if (!outputSignal) { setError('Register a device in this project before using the LED template.'); return; }
    if ((document as LogicGraph).nodes.length && !window.confirm('Replace this draft with the LED template?')) return;
    edit({ schemaVersion: 1, nodes: [{ id: 'power', kind: 'constant', label: 'Power', value: false, x: 90, y: 160 }, { id: 'led', kind: 'output', label: 'LED', signalId: outputSignal.id, x: 410, y: 160 }], edges: [{ id: 'power-led', source: 'power', target: 'led', port: 'in' }] });
  }
  function addItem(itemKind: ScreenItem['kind']) {
    if (['indicator', 'button'].includes(itemKind) && !outputSignal) { setError('Register a device signal before adding a bound element.'); return; }
    const scene = document as Screen;
    const item: ScreenItem = { id: crypto.randomUUID(), kind: itemKind, label: itemKind[0]!.toUpperCase() + itemKind.slice(1), x: 40 + (scene.items.length % 4) * 200, y: 60 + Math.floor(scene.items.length / 4) * 130, width: itemKind === 'group' ? 400 : 170, height: itemKind === 'group' ? 240 : 90,
      ...(['indicator', 'button'].includes(itemKind) ? { signalId: outputSignal!.id } : {}) };
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
  return <div className="engineering">
    <section className="panel scheme-browser"><div className="scheme-browser-heading"><Field label="Editor project"><select value={projectId} onChange={(e) => { if (discardAllowed()) { setProjectId(e.target.value); setDraft(null); setDocument(null); } }}>{projects.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field><form onSubmit={create}><Field label="Scheme name"><input required maxLength={128} value={name} placeholder={kind === 'graph' ? 'e.g. LED automation' : 'e.g. Operator overview'} onChange={(e) => setName(e.target.value)} /></Field><button className="primary" disabled={busy || !projectId}>Create {kind}</button></form></div><div className="scheme-tabs">{list.items.map((item) => <button key={item.id} className={draft?.id === item.id ? 'scheme-tab selected' : 'scheme-tab'} aria-label={`Open ${item.name}`} onClick={() => open(item.id)}>{item.name}<small>r{item.revision}</small></button>)}{list.nextCursor && <button className="secondary" onClick={() => { void perform(async () => { const next = await api<Page<Draft>>(`/projects/${projectId}/${kind}s?cursor=${list.nextCursor}`); setList({ items: [...list.items, ...next.items], nextCursor: next.nextCursor }); }); }}>More schemes</button>}</div></section>
    {error && <div role="alert" className="alert">{error}</div>}{message && <div role="status" className="editor-message">{message}</div>}
    {!draft || !document ? <section className="panel empty"><h2>{kind === 'graph' ? 'Build the logic behind your process.' : 'Give your process a clear visual home.'}</h2><p>Create a {kind} above, or open a saved draft.</p></section> : <>
      <div className="editor-toolbar"><div><strong>{draft.name}</strong><span className="badge warning">Draft r{draft.revision}{dirty ? ' · Unsaved' : ''}</span><span className="badge good">Simulation</span></div><div><button className="secondary" aria-label="Undo" disabled={!history.current?.canUndo} onClick={() => undo()}>↶</button><button className="secondary" aria-label="Redo" disabled={!history.current?.canRedo} onClick={() => undo(true)}>↷</button><button className="secondary" onClick={() => { setText(JSON.stringify(document, null, 2)); setTextMode(!textMode); }}>JSON</button><button className="primary" disabled={busy || !dirty} onClick={() => { void perform(save); }}>Save draft</button><button className="secondary" disabled={busy || dirty} onClick={() => { void perform(async () => { await api(`/${kind}s/${draft.id}/revisions`, { method: 'POST', headers: { 'If-Match': `"${draft.revision}"` } }); setMessage(`Revision ${draft.revision} prepared`); const result = await api<{ items: Array<{ revision: number; checksum: string }> }>(`/${kind}s/${draft.id}/revisions`); setRevisions(result.items); }); }}>Prepare revision</button></div></div>
      {textMode ? <section className="panel json-editor"><Field label="JSON document"><textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} /></Field><button className="primary" onClick={() => { try { edit(kind === 'graph' ? validateGraph(JSON.parse(text), false) : validateScreen(JSON.parse(text))); setTextMode(false); } catch (reason) { setError(String(reason)); } }}>Apply JSON</button></section> : <div className="editor-grid"><section className="panel canvas-panel"><div className="canvas-tools">{kind === 'graph' ? <><select aria-label="Block type" value={blockKind} onChange={(e) => setBlockKind(e.target.value as BlockKind)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="secondary" onClick={addBlock}>Add block</button><button className="text-button" onClick={template}>LED template</button></> : <>{(['label', 'indicator', 'button', 'group'] as const).map((item) => <button className="secondary" key={item} onClick={() => addItem(item)}>Add {item}</button>)}</>}</div>
        {kind === 'graph' ? <GraphCanvas graph={document as LogicGraph} selected={selected} select={setSelected} edit={edit} onError={setError} result={simulation} /> : <ScreenCanvas screen={document as Screen} selected={selected} select={setSelected} edit={edit} />}
        <div className="canvas-footer">{kind === 'graph' ? 'Connect output handles to input ports. Timers use monotonic time.' : 'Drag elements or use arrow keys. Hold Shift for 1 px movement.'}</div></section>
        <aside className="panel inspector"><div className="panel-heading"><h2>Properties</h2></div>{selectedItem ? <div className="inspector-fields"><span className="eyebrow">{selectedItem.kind}</span><Field label={kind === 'graph' ? 'Block label' : 'Element label'}><input maxLength={128} value={selectedItem.label} onChange={(e) => update({ label: e.target.value })} /></Field>
          <div className="coordinate-fields">{(['x', 'y'] as const).map((axis) => <Field key={axis} label={axis.toUpperCase()}><input type="number" min={-100000} max={100000} value={selectedItem[axis]} onChange={(e) => update({ [axis]: Number(e.target.value) })} /></Field>)}</div>
          {'signalId' in selectedItem && <Field label="Signal binding"><select value={selectedItem.signalId} onChange={(e) => update({ signalId: e.target.value })}>{available.filter((s) => !['button', 'output'].includes(selectedItem.kind) || s.direction === 'output').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
          {selectedItem.kind === 'constant' && <label className="checkbox-field"><input aria-label="Constant value" type="checkbox" checked={(selectedItem as LogicNode).value} onChange={(e) => update({ value: e.target.checked })} />Constant value (ON)</label>}
          {'delayMs' in selectedItem && <Field label="Delay (ms)"><input type="number" min={0} max={86400000} value={selectedItem.delayMs} onChange={(e) => update({ delayMs: Number(e.target.value) })} /></Field>}
          {kind === 'screen' && <><div className="coordinate-fields">{(['width', 'height'] as const).map((axis) => <Field key={axis} label={axis === 'width' ? 'Width' : 'Height'}><input type="number" min={1} max={10000} value={(selectedItem as ScreenItem)[axis]} onChange={(e) => update({ [axis]: Number(e.target.value) })} /></Field>)}</div><Field label="Parent group"><select value={(selectedItem as ScreenItem).groupId ?? ''} onChange={(e) => { const scene = document as Screen; const next = { ...scene, items: scene.items.map((n) => { if (n.id !== selected) return n; const copy = { ...n }; if (e.target.value) copy.groupId = e.target.value; else delete copy.groupId; return copy; }) }; try { edit(validateScreen(next)); } catch (reason) { setError(String(reason)); } }}>{[<option key="none" value="">None</option>, ...(document as Screen).items.filter((i) => i.kind === 'group' && i.id !== selected).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)]}</select></Field></>}
          <button className="secondary danger-text" onClick={remove}>Delete selected</button></div> : <div className="inspector-empty">Select an element to edit its properties.</div>}</aside></div>}
      {kind === 'graph' && <section className="panel simulation-panel"><div><h2>Simulation bench</h2><p className="muted">Run the saved draft for 5 seconds in virtual time. No physical commands are sent.</p></div><div className="simulation-inputs">{(document as LogicGraph).nodes.filter((n) => n.kind === 'input').map((n) => <Field key={n.id} label={`Simulate ${n.label}`}><select value={simInputs[n.signalId!] === null ? 'bad' : simInputs[n.signalId!] ? 'on' : 'off'} onChange={(e) => setSimInputs({ ...simInputs, [n.signalId!]: e.target.value === 'bad' ? null : e.target.value === 'on' })}><option value="off">OFF</option><option value="on">ON</option><option value="bad">Disconnected</option></select></Field>)}</div><button className="primary" disabled={busy || dirty} onClick={() => { void perform(async () => {
        const inputs = Object.fromEntries((document as LogicGraph).nodes.filter((n) => n.kind === 'input').map((n) => [n.signalId!, Object.hasOwn(simInputs, n.signalId!) ? simInputs[n.signalId!] : false]));
        const result = await api<{ steps: LogicResult[] }>(`/graphs/${draft.id}/simulate`, { method: 'POST', body: { steps: Array.from({ length: 51 }, (_, i) => ({ atMs: i * 100, inputs })) } }); setSimulation(result.steps.at(-1)!);
      }); }}>Run simulation</button>{simulation && <div role="status" aria-label="Simulation result" className="simulation-result">{Object.entries(simulation.outputs).map(([id, value]) => <span key={id}><strong>{available.find((s) => s.id === id)?.name ?? id}</strong><span className={`badge ${value.quality === 'Good' ? 'good' : 'warning'}`}>{value.value === null ? 'No output' : value.value ? 'ON' : 'OFF'}</span>{value.reason && <small>{value.reason}</small>}</span>)}{!Object.keys(simulation.outputs).length && <span>Graph evaluated; no output blocks configured.</span>}</div>}</section>}
      {!!revisions.length && <section className="panel revision-list"><h2>Prepared revisions</h2><p className="muted">Immutable snapshots. Preparation does not activate equipment.</p>{revisions.map((r) => <div key={r.revision}>Revision {r.revision}<code>{r.checksum.slice(0, 16)}</code></div>)}</section>}
    </>}
  </div>;
}

type FlowBlock = Node<{ item: LogicNode; select: (id: string) => void; result?: string }, 'block'>;
function BlockView({ data, selected }: NodeProps<FlowBlock>) {
  const item = data.item;
  return <div className={`logic-block ${selected ? 'selected' : ''}`}><span className="block-kind">{labels[item.kind]}</span><button className="block-title nodrag" aria-label={`Select ${item.label}`} onClick={() => data.select(item.id)}>{item.label}</button><span className="block-value">{data.result ?? (item.kind === 'constant' ? item.value ? 'ON' : 'OFF' : timed.has(item.kind) ? `${item.delayMs} ms` : 'Boolean')}</span>
    {ports[item.kind].map((port, i, all) => <Handle key={port} type="target" position={Position.Left} id={port} style={{ top: `${((i + 1) / (all.length + 1)) * 100}%` }} aria-label={`Input ${port}`}><span className="port-label">{port}</span></Handle>)}{item.kind !== 'output' && <Handle type="source" position={Position.Right} id="out" aria-label="Output" />}</div>;
}
const nodeTypes = { block: BlockView };
function GraphCanvas({ graph, selected, select, edit, onError, result }: { graph: LogicGraph; selected: string; select: (id: string) => void; edit: (value: Document) => void; onError: (message: string) => void; result: LogicResult | null }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowBlock>([]);
  const [source, setSource] = useState(''); const [target, setTarget] = useState(''); const [port, setPort] = useState('');
  useEffect(() => { setNodes(graph.nodes.map((n) => ({ id: n.id, type: 'block', deletable: false, position: { x: n.x, y: n.y }, selected: n.id === selected, data: { item: n, select, ...(result?.nodes[n.id] ? { result: result.nodes[n.id]!.value === null ? 'Unavailable' : result.nodes[n.id]!.value ? 'ON' : 'OFF' } : {}) } }))); }, [graph, selected, select, result, setNodes]);
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
      <rect width={item.width} height={item.height} rx={item.kind === 'group' ? 12 : 8} />{item.kind === 'indicator' && <circle cx={22} cy={item.height / 2} r={8} className="unknown-lamp" />}<text x={item.kind === 'indicator' ? 42 : 14} y={item.kind === 'group' ? 26 : item.height / 2 - (item.kind === 'indicator' ? 4 : -5)}>{item.label}</text>{item.kind === 'indicator' && <text x={42} y={item.height / 2 + 17} className="hmi-quality">No live data</text>}{item.kind === 'button' && <text x={14} y={item.height - 12} className="hmi-quality">Design only</text>}</g>)}</svg></div>;
}
