import {memo} from 'react';
import type {Signal,Sample} from '../../api.js';
import {formatSignalValue} from '../../signal-format.js';
import {SignalPresentation} from './signal-presentation.js';
import {Rename} from './rename.js';
const SignalRename=memo(Rename);
/** Stable row props avoid rebuilding the catalog on each telemetry poll. */
export const SignalRow=memo(function SignalRow({signal,value,quality,changed,control,history}:{signal:Signal;value:Sample['value']|undefined;quality:string;changed:()=>Promise<void>;control:(signal:Signal)=>void;history:(signal:Signal)=>void}){
  return <tr><td><strong>{signal.name}</strong><SignalRename key={signal.revision} kind="signals" id={signal.id} name={signal.name} revision={signal.revision??1} changed={changed}/>{signal.dataType==='float64'&&<SignalPresentation key={`display-${signal.revision}`} signal={signal} changed={changed}/>}</td><td className="signal-value">{formatSignalValue(value,signal)}</td><td><span className={`badge ${quality==='Good'?'good':'warning'}`}><span className="dot"/>{quality}</span></td><td>{signal.dataType}</td><td>{signal.direction}</td><td><button className="secondary signal-control-button" disabled={quality!=='Good'||signal.direction!=='output'} onClick={()=>control(signal)}>Control</button><button className="secondary signal-control-button" onClick={()=>history(signal)}>History</button></td></tr>;
});
