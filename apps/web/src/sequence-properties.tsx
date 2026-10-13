import type { SequenceSettings, SequenceState } from '../../../packages/domain/src/sequence.js';
export function SequenceProperties({ settings, update, result }: { settings: SequenceSettings; update: (settings: SequenceSettings) => void; result?: SequenceState | undefined }) {
  const change = (index: number, values: Partial<SequenceSettings['steps'][number]>) => update({ ...settings, steps: settings.steps.map((step, i) => i === index ? { ...step, ...values } : step) });
  const move = (index: number, offset: number) => { const steps = [...settings.steps]; [steps[index], steps[index + offset]] = [steps[index + offset]!, steps[index]!]; update({ ...settings, steps }); };
  return <>
    <label className="field"><span>Sequence maximum interval (ms)</span><input type="number" min={100} max={10000} step={1} value={settings.maxIntervalMs} onChange={(e) => update({ ...settings, maxIntervalMs: e.target.valueAsNumber })} /></label>
    <p className="muted">Start requires OFF then ON while permitted. Cancel or lost permission aborts to OFF. No automatic repeat or resume. Durations start when a value is requested, not when equipment confirms it.</p>
    {result && <p role="status" aria-label="Sequence simulation state">{result.state}{result.step !== null ? ` · Step ${result.step + 1}: ${result.label}` : ''}</p>}
    <div className="sequence-steps">{settings.steps.map((step, i) => <fieldset className="sequence-step" key={i}><legend>Step {i + 1}</legend>
      <label className="field"><span>Step {i + 1} label</span><input maxLength={64} value={step.label} onChange={(e) => change(i, { label: e.target.value })} /></label>
      <label className="field"><span>Step {i + 1} duration (ms)</span><input type="number" min={100} max={86400000} step={1} value={step.durationMs} onChange={(e) => change(i, { durationMs: e.target.valueAsNumber })} /></label>
      <label className="checkbox-field"><input type="checkbox" checked={step.value} onChange={(e) => change(i, { value: e.target.checked })} />Step {i + 1} ON</label>
      <div className="sequence-actions"><button className="text-button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</button><button className="text-button" aria-label={`Move step ${i + 1} down`} disabled={i === settings.steps.length - 1} onClick={() => move(i, 1)}>Down</button><button className="text-button" aria-label={`Remove step ${i + 1}`} disabled={settings.steps.length === 1} onClick={() => update({ ...settings, steps: settings.steps.filter((_, index) => index !== i) })}>Remove</button></div>
    </fieldset>)}</div>
    <button className="secondary" disabled={settings.steps.length >= 16} onClick={() => update({ ...settings, steps: [...settings.steps, { label: `Step ${settings.steps.length + 1}`, value: false, durationMs: 1000 }] })}>Add sequence step</button>
  </>;
}
