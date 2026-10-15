import type { Device, Project, Signal } from '../../api.js';
import { Rename } from '../catalog/rename.js';

export type ProjectSection = 'Project'|'Devices'|'Signals'|'Logic'|'Screens'|'Alarms'|'Recipes';
export function ProjectWorkspace({project,devices,signals,navigate,refresh}:{project:Project;devices:Device[];signals:Signal[];navigate:(view:ProjectSection)=>void;refresh:()=>Promise<void>}) {
  return <>
    <section className="panel project-intro"><span className="eyebrow">PROJECT WORKSPACE</span><h2>Connect equipment. Design logic. Operate your process.</h2><p className="muted">This workspace keeps equipment, signals, control graphs and screens together. Every command and configuration change is recorded.</p>
      <div className="project-actions"><button className="primary" onClick={()=>navigate('Devices')}>Open devices</button><button className="secondary" onClick={()=>navigate('Logic')}>Design logic</button><button className="secondary" onClick={()=>navigate('Screens')}>Operator screens</button><button className="secondary" onClick={()=>navigate('Recipes')}>Thermal recipes</button></div>
    </section>
    <div className="overview-grid"><section className="panel project-intro"><h2>Equipment and signals</h2><p className="muted">{devices.length} loaded devices · {signals.length} loaded signals</p><ol className="project-steps"><li>Start virtual simulators in Devices.</li><li>Open a graph in Logic, inspect its blocks and run a simulation.</li><li>Activate a prepared revision with an explicit reason.</li><li>Open a screen in Screens and choose Operate revision.</li><li>Stop the graph to revoke its output control sessions.</li></ol><p className="muted">A demo uses virtual equipment only. Physical devices require separate commissioning.</p></section>
    <section className="panel project-intro"><h2>Project settings</h2><p className="muted">Configuration revision {project.revision}. Renaming preserves devices, documents and signal identities.</p><Rename key={project.revision} kind="projects" id={project.id} name={project.name} revision={project.revision} changed={refresh}/><div className="project-actions"><button className="secondary" onClick={()=>navigate('Signals')}>Inspect signals</button><button className="secondary" onClick={()=>navigate('Alarms')}>Review alarms</button></div></section></div>
  </>;
}
