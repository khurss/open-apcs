export const views = ['Overview','Projects','Devices','Signals','Alarms','Logic','Screens','Activity','System'] as const;
export type View = typeof views[number] | 'Project';
export interface WorkspaceRoute { view: View; project: string; }
export function readRoute(hash = window.location.hash): WorkspaceRoute {
  const params = new URLSearchParams(hash.slice(1));
  const candidate=params.get('view'); const project=params.get('project')??'';
  const view=(candidate==='Project'||views.includes(candidate as typeof views[number]))?candidate as View:'Overview';
  return {view,project:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project)?project:''};
}
export function routeHash(view:View,project='') { return `#${new URLSearchParams({view,...(project?{project}:{})})}`; }
