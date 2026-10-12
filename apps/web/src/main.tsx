import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, setSession, type User, type Project, type Device, type Signal, type Sample, type Audit, type Page } from './api.js';
import './style.css';
import { EditorWorkspace } from './editors.js';
import { SignalHistory } from './signal-history.js';
import { ManualControl, VirtualDeviceControl } from './runtime-controls.js';

const views = ['Overview', 'Projects', 'Devices', 'Signals', 'Logic', 'Screens', 'Activity', 'System'] as const;
type View = typeof views[number];
const empty = <T,>(): Page<T> => ({ items: [], nextCursor: null });
const paths: Record<string, string> = {
  Logic: 'M3 3h6v6H3z M15 15h6v6h-6z M9 6h9v9 M6 9v9h9', Screens: 'M2 3h20v15H2z M8 22h8 M12 18v4',
  Overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  Projects: 'M3 7h7l2-3h9v16H3z', Devices: 'M6 6h12v12H6z M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5',
  Signals: 'M2 12h4l3-8 6 16 3-8h4', Activity: 'M5 3h14v18H5z M8 8h8M8 12h8M8 16h5',
  System: 'M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2M16 8l2-2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11', sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  menu: 'M3 6h18M3 12h18M3 18h18', plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', logout: 'M9 4H4v16h5M10 12h11m-4-4 4 4-4 4', refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
};
function Icon({ name }: { name: string }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.Devices} /></svg>; }
function Brand() { return <div className="brand"><span className="brand-mark"><Icon name="Signals" /></span><span>Open APCS<small>AUTOMATION WORKSPACE</small></span></div>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name="Projects" /></span><h3>{title}</h3><p>{children}</p></div>; }
function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}><span className="dot" />{children}</span>; }
const actionNames: Record<string, string> = { 'admin.created': 'Administrator created', 'auth.login': 'Signed in', 'auth.logout': 'Signed out', 'auth.failed': 'Sign-in failed', 'project.created': 'Project created', 'project.updated': 'Project updated', 'device.created': 'Device created' };

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [editorDirty, setEditorDirty] = useState(false);
  const [view, setView] = useState<View>('Overview');
  const [theme, setTheme] = useState(() => localStorage.getItem('open-apcs-theme') === 'light' ? 'light' : 'dark');
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [projects, setProjects] = useState<Page<Project>>(empty);
  const [devices, setDevices] = useState<Page<Device>>(empty);
  const [signals, setSignals] = useState<Page<Signal>>(empty);
  const [activity, setActivity] = useState<Page<Audit>>(empty);
  const [values, setValues] = useState<Record<string, Sample>>({});
  const [historyTarget, setHistoryTarget] = useState<Signal | null>(null);
  const [controlTarget, setControlTarget] = useState<Signal | null>(null);
  const [selectedProject, setSelectedProject] = useState('');
  const [projectName, setProjectName] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [deviceAddress, setDeviceAddress] = useState('');
  const [deviceKind, setDeviceKind] = useState('virtual-led');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const authenticate = (current: User | null) => { setSession(current); setUser(current); };
  function failure(reason: unknown) {
    if (reason instanceof ApiError && reason.status === 401) authenticate(null);
    setError(reason instanceof Error ? reason.message : 'Connection unavailable. Please try again.');
  }
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('open-apcs-theme', theme); }, [theme]);
  useEffect(() => {
    let active = true;
    void api<User>('/auth/me').then((current) => { if (active) authenticate(current); }).catch(() => {}).finally(() => { if (active) setInitializing(false); });
    return () => { active = false; };
  }, []);
  async function refresh() {
    const [p, d, s, a] = await Promise.all([api<Page<Project>>('/projects'), api<Page<Device>>('/devices'), api<Page<Signal>>('/signals'), api<Page<Audit>>('/audit')]);
    setProjects(p); setDevices(d); setSignals(s); setActivity(a); setConnected(true);
    setSelectedProject((selected) => selected || p.items[0]?.id || '');
  }
  useEffect(() => {
    if (user) void refresh().catch((reason: unknown) => { setConnected(false); failure(reason); });
    else { setProjects(empty()); setDevices(empty()); setSignals(empty()); setActivity(empty()); setValues({}); setConnected(false); }
  }, [user]);
  useEffect(() => {
    if (!user || view !== 'Signals') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const updates = await Promise.all(signals.items.map(async (signal) => [signal.id, await api<Sample>(`/signals/${signal.id}/value`)] as const));
        if (!cancelled) { setValues(Object.fromEntries(updates)); setConnected(true); }
      } catch (reason) { if (!cancelled) { setConnected(false); failure(reason); } }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [user, view, signals]);
  function navigate(next: View) { if (next !== view && editorDirty && !window.confirm('Discard unsaved changes to this draft?')) return; setView(next); setControlTarget(null); setHistoryTarget(null); setMenu(false); setError(''); }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { failure(reason); } finally { setBusy(false); }
  }
  function signIn(event: FormEvent) {
    event.preventDefault();
    void perform(async () => { const current = await api<User>('/auth/login', { method: 'POST', body: { username, password } }); authenticate(current); setPassword(''); setView('Overview'); });
  }
  function createProject(event: FormEvent) {
    event.preventDefault();
    void perform(async () => { const created = await api<Project>('/projects', { method: 'POST', body: { name: projectName } }); setSelectedProject(created.id); setProjectName(''); await refresh(); });
  }
  function addDevice(event: FormEvent) {
    event.preventDefault();
    void perform(async () => { await api('/devices', { method: 'POST', body: { projectId: selectedProject, name: deviceName, siteId, deviceId: deviceAddress, kind: deviceKind } }); setDeviceName(''); setDeviceAddress(''); await refresh(); });
  }
  async function more(kind: 'projects' | 'devices' | 'signals' | 'audit') {
    const merge = <T extends { id: string }>(old: Page<T>, next: Page<T>): Page<T> => ({ items: [...old.items, ...next.items.filter((item) => !old.items.some((prior) => prior.id === item.id))], nextCursor: next.nextCursor });
    if (kind === 'projects') setProjects(merge(projects, await api<Page<Project>>(`/projects?cursor=${projects.nextCursor}`)));
    if (kind === 'devices') setDevices(merge(devices, await api<Page<Device>>(`/devices?cursor=${devices.nextCursor}`)));
    if (kind === 'signals') setSignals(merge(signals, await api<Page<Signal>>(`/signals?cursor=${signals.nextCursor}`)));
    if (kind === 'audit') setActivity(merge(activity, await api<Page<Audit>>(`/audit?cursor=${activity.nextCursor}`)));
  }
  const themeButton = <button className="icon-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>;
  const errorBanner = error && <div className="alert" role="alert">{error}<button aria-label="Dismiss message" onClick={() => setError('')}>×</button></div>;

  if (initializing) return <div className="loading" role="status"><Brand /><p>Opening your workspace…</p></div>;
  if (!user) return <div className="login-page"><div className="login-top"><Brand />{themeButton}</div><main className="login-card">
    <span className="eyebrow">LOCAL ACCESS</span><h1>Welcome back.</h1><p className="muted">Sign in to your automation workspace.</p>
    {errorBanner}<form onSubmit={signIn}>
      <Field label="Username"><input autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <button className="primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<Icon name="arrow" /></button>
    </form><p className="login-note">Your system. Your data. Locally connected.</p></main><footer className="login-footer">OPEN APCS <span>Open automation, under your control.</span></footer></div>;

  return <div className="workspace">
    {menu && <button className="scrim" aria-label="Close navigation" onClick={() => setMenu(false)} />}
    <aside className={`sidebar ${menu ? 'open' : ''}`}><Brand /><div className="workspace-label"><span className="workspace-avatar">L</span><div>Local workspace<small>Automation platform</small></div></div>
      <p className="nav-label">WORKSPACE</p><nav aria-label="Main navigation">{views.map((item) => <button key={item} className={view === item ? 'nav-item active' : 'nav-item'} onClick={() => navigate(item)} aria-current={view === item ? 'page' : undefined}><Icon name={item} />{item}{view === item && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-footer"><div className="local-note"><span className="dot" />Local operation<small>No cloud connection required</small></div><div className="user-row"><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><div>{user.username}<small>Administrator</small></div><button className="icon-button" aria-label="Sign out" onClick={() => { void perform(async () => { await api('/auth/logout', { method: 'POST' }); authenticate(null); }); }}><Icon name="logout" /></button></div></div>
    </aside>
    <div className="main-column"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="menu" /></button><span>Workspace</span><span className="divider">/</span><strong>{view}</strong></div><div className="topbar-actions"><Badge tone={connected ? 'good' : 'warning'}>{connected ? 'API connected' : 'Connecting'}</Badge>{themeButton}</div></header>
      <main className="content"><div className="page-heading"><div><span className="eyebrow">YOUR AUTOMATION, AT A GLANCE</span><h1>{view}</h1><p className="muted">{{ Overview: 'A clear view of your projects, devices, and system activity.', Projects: 'Organize your automation into focused workspaces.', Devices: 'Connect your equipment and virtual test devices.', Signals: 'Inspect current values and the quality of every reading.', Logic: 'Design, test, and prepare executable control graphs.', Screens: 'Arrange your operator screens and connect their signals.', Activity: 'A record of account and configuration changes.', System: 'Your local platform and development environment.' }[view]}</p></div><button className="secondary" disabled={busy} onClick={() => { void perform(refresh); }}><Icon name="refresh" />Refresh</button></div>
      {errorBanner}
      {view === 'Overview' && <>
        <div className="stats">{[{ title: 'Loaded projects', value: projects.items.length, icon: 'Projects', note: 'Organized workspaces' }, { title: 'Loaded devices', value: devices.items.length, icon: 'Devices', note: 'Registered in the catalog' }, { title: 'Loaded signals', value: signals.items.length, icon: 'Signals', note: 'Configured I/O points' }].map((stat) => <section className="stat-card" key={stat.title}><div><span className="muted">{stat.title}</span><strong>{stat.value}</strong><small>{stat.note}</small></div><span className="stat-icon"><Icon name={stat.icon} /></span></section>)}</div>
        <section className="getting-started"><div><Badge tone="good">BUILD YOUR WORKSPACE</Badge><h2>From your first signal<br />to your next automation.</h2><p>Start with a project, add a device, and explore its signals.<br className="desktop-break" /> Keep every change visible along the way.</p><button className="primary" onClick={() => navigate('Projects')}>Open projects<Icon name="arrow" /></button></div><div className="connection-art" aria-hidden="true"><div className="art-grid" /><div className="art-node node-device"><Icon name="Devices" /><span>DEVICE</span></div><div className="art-wire" /><div className="art-node node-signal"><Icon name="Signals" /><span>SIGNAL</span></div><div className="art-caption">CONNECT · OBSERVE · CONTROL</div></div></section>
        <div className="overview-grid"><section className="panel"><div className="panel-heading"><h2>Projects</h2><button className="text-button" onClick={() => navigate('Projects')}>View all<Icon name="arrow" /></button></div>{projects.items.length ? <div className="project-list">{projects.items.slice(0, 4).map((project) => <div className="list-row" key={project.id}><span className="list-icon"><Icon name="Projects" /></span><div><strong>{project.name}</strong><small>Revision {project.revision}</small></div><Badge>Draft</Badge></div>)}</div> : <Empty title="A place for your first automation">Create a project to organize equipment, signals, and future control schemes.</Empty>}</section><section className="panel"><div className="panel-heading"><h2>Recent activity</h2><button className="text-button" onClick={() => navigate('Activity')}>View log<Icon name="arrow" /></button></div><ActivityList items={activity.items.slice(0, 4)} /></section></div>
      </>}
      {view === 'Projects' && <><section className="panel form-panel"><div><h2>Create a project</h2><p className="muted">Give this automation a recognizable name.</p></div><form className="inline-form" onSubmit={createProject}><Field label="Project name"><input required maxLength={128} placeholder="e.g. Workshop automation" value={projectName} onChange={(e) => setProjectName(e.target.value)} /></Field><button className="primary" disabled={busy}><Icon name="plus" />Create project</button></form></section><section className="panel"><div className="panel-heading"><h2>Your projects</h2><span className="count">{projects.items.length}</span></div>{projects.items.length ? projects.items.map((project) => <div className="list-row" key={project.id}><span className="list-icon"><Icon name="Projects" /></span><div><strong>{project.name}</strong><small>Revision {project.revision}</small></div><Badge>Draft</Badge></div>) : <Empty title="No projects yet">Create your first project above to get started.</Empty>}{projects.nextCursor && <button className="secondary load-more" onClick={() => { void perform(() => more('projects')); }}>Load more projects</button>}</section></>}
      {view === 'Devices' && <><section className="panel form-panel"><div><h2>Add a device</h2><p className="muted">Register a virtual LED or an ESP32 LED profile.</p></div><form className="device-form" onSubmit={addDevice}>
        <Field label="Project"><select required value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}><option value="" disabled>Select a project</option>{projects.items.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field>
        <Field label="Device name"><input required maxLength={128} value={deviceName} placeholder="e.g. Workbench LED" onChange={(e) => setDeviceName(e.target.value)} /></Field>
        <Field label="Device profile"><select value={deviceKind} onChange={(e) => setDeviceKind(e.target.value)}><option value="virtual-led">Virtual LED</option><option value="esp32-led">ESP32 LED</option></select></Field>
        <Field label="Site ID"><input required pattern="[A-Za-z0-9_-]+" maxLength={128} value={siteId} placeholder="e.g. workshop" onChange={(e) => setSiteId(e.target.value)} /></Field>
        <Field label="Device address"><input required pattern="[A-Za-z0-9_-]+" maxLength={128} value={deviceAddress} placeholder="e.g. esp32-1" onChange={(e) => setDeviceAddress(e.target.value)} /></Field>
        <div className="form-action"><button className="primary" disabled={busy || !selectedProject}><Icon name="plus" />Add device</button></div>
      </form>{!projects.items.length && <p className="muted">Create a project before adding a device.</p>}<p className="form-note">Registration adds a catalog entry. Start a virtual simulator to test control. Physical profiles require future commissioning support.</p></section><section className="panel"><div className="panel-heading"><h2>Device catalog</h2><span className="count">{devices.items.length}</span></div>{devices.items.length ? <div className="device-grid">{devices.items.map((device) => <article className="device-card" key={device.id}><div className="device-top"><span className="list-icon"><Icon name="Devices" /></span><Badge tone="warning">{device.kind === 'virtual-led' ? 'Virtual device' : 'Not commissioned'}</Badge></div><h3>{device.name}</h3><p className="muted">{device.kind === 'virtual-led' ? 'Virtual LED' : 'ESP32 LED'}</p><dl><div><dt>Site</dt><dd>{device.siteId}</dd></div><div><dt>Address</dt><dd>{device.deviceId}</dd></div></dl>{device.kind === 'virtual-led' && <VirtualDeviceControl deviceId={device.id} />}</article>)}</div> : <Empty title="No devices registered">Add a device to create its first output signal.</Empty>}{devices.nextCursor && <button className="secondary load-more" onClick={() => { void perform(() => more('devices')); }}>Load more devices</button>}</section></>}
      {view === 'Signals' && <section className="panel"><div className="panel-heading"><h2>Signal monitor</h2><Badge>Refreshes every second</Badge></div>{signals.items.length ? <div className="table-scroll"><table><thead><tr><th>Signal</th><th>Value</th><th>Quality</th><th>Type</th><th>Direction</th><th>Actions</th></tr></thead><tbody>{signals.items.map((signal) => { const sample = values[signal.id]; const quality = !connected ? 'Disconnected' : sample?.quality ?? 'Loading'; return <tr key={signal.id}><td><strong>{signal.name}</strong></td><td className="signal-value">{sample?.value == null ? 'No data' : sample.value ? 'ON' : 'OFF'}</td><td><Badge tone={quality === 'Good' ? 'good' : 'warning'}>{quality}</Badge></td><td>{signal.dataType}</td><td>{signal.direction}</td><td><button className="secondary signal-control-button" disabled={quality !== 'Good' || signal.direction !== 'output'} onClick={() => setControlTarget(signal)}>Control</button><button className="secondary signal-control-button" onClick={() => setHistoryTarget(signal)}>History</button></td></tr>; })}</tbody></table></div> : <Empty title="No signals configured">Register a device to inspect its signals here.</Empty>}{signals.nextCursor && <button className="secondary load-more" onClick={() => { void perform(() => more('signals')); }}>Load more signals</button>}</section>}
      {view === 'Signals' && controlTarget && <ManualControl key={controlTarget.id} signal={controlTarget} revision={projects.items.find((p) => p.id === devices.items.find((d) => d.id === controlTarget.deviceId)?.projectId)?.revision ?? 0} quality={connected ? values[controlTarget.id]?.quality ?? 'Disconnected' : 'Disconnected'} close={() => setControlTarget(null)} />}
      {view === 'Signals' && historyTarget && <SignalHistory key={historyTarget.id} signal={historyTarget} close={() => setHistoryTarget(null)} />}
      {(view === 'Logic' || view === 'Screens') && <EditorWorkspace key={view} kind={view === 'Logic' ? 'graph' : 'screen'} projects={projects.items} devices={devices.items} signals={signals.items} initialProject={selectedProject} onDirty={setEditorDirty} />}
      {view === 'Activity' && <section className="panel"><div className="panel-heading"><h2>Audit trail</h2><span className="muted">Times shown in your local timezone</span></div><ActivityList items={activity.items} />{activity.nextCursor && <button className="secondary load-more" onClick={() => { void perform(() => more('audit')); }}>Load more activity</button>}</section>}
      {view === 'System' && <div className="overview-grid"><section className="panel"><div className="panel-heading"><h2>Platform</h2><Badge tone="good">Local</Badge></div><dl className="system-details"><div><dt>Application</dt><dd>Open APCS</dd></div><div><dt>API</dt><dd>{connected ? 'Connected' : 'Unavailable'}</dd></div><div><dt>Account</dt><dd>{user.username}</dd></div><div><dt>Current release</dt><dd>Foundation preview</dd></div></dl></section><section className="panel"><div className="panel-heading"><h2>Workspace status</h2></div><div className="system-copy"><p>Projects, the device catalog, and the audit trail are stored locally.</p><p className="muted">Visual editors support saved drafts and isolated simulation. Virtual devices run in a separate server process. Prepared graphs execute on the server and operator screens share the audited command path. Physical commissioning remains pending. Catalog entries do not enable physical outputs.</p></div></section></div>}
      <footer className="content-footer"><span>Open APCS</span><span>Local automation workspace · Foundation preview</span></footer></main>
    </div>
  </div>;
}
function ActivityList({ items }: { items: Audit[] }) {
  if (!items.length) return <Empty title="No activity yet">Account and configuration changes will appear here.</Empty>;
  return <div className="activity-list">{items.map((item) => <div className="activity-row" key={item.id}><span className="activity-dot" /><div><strong>{actionNames[item.action] ?? item.action}</strong><time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time></div><span className="audit-id">#{item.id}</span></div>)}</div>;
}
createRoot(document.getElementById('root')!).render(<App />);
