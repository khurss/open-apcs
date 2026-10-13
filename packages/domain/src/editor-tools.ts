import { validateGraph, type LogicGraph } from './logic.js';
import { validateScreen, type Screen } from './screen.js';

const shifted = (value:number) => Math.min(100000, value + 40);
const copyLabel = (value:string) => `${value.slice(0,123)} copy`;

export function duplicateGraphNode(graph: LogicGraph, id: string, nextId: string): LogicGraph {
  const source = graph.nodes.find(node=>node.id===id);
  if(!source || graph.nodes.some(node=>node.id===nextId)) throw new Error('Choose a block and a unique identifier');
  const copy = structuredClone(source);
  // Connections stay deliberate: duplication never creates another execution path.
  return validateGraph({...graph,nodes:[...graph.nodes,{...copy,id:nextId,label:copyLabel(copy.label),x:shifted(copy.x),y:shifted(copy.y)}]},false);
}

export function arrangeGraph(graph: LogicGraph): LogicGraph {
  validateGraph(graph,false);
  const remaining = new Set(graph.nodes.map(node=>node.id)); const levels = new Map<string,number>();
  while(remaining.size) {
    let progress=false;
    for(const id of remaining) {
      const inputs=graph.edges.filter(edge=>edge.target===id).map(edge=>edge.source);
      if(inputs.some(source=>!levels.has(source))) continue;
      levels.set(id,inputs.length?1+Math.max(...inputs.map(source=>levels.get(source)!)):0);
      remaining.delete(id);progress=true;
    }
    if(!progress) throw new Error('Cannot arrange a cyclic graph');
  }
  const rows = new Map<number,number>();
  return {...structuredClone(graph),nodes:graph.nodes.map(node=>{
    const level=levels.get(node.id)!;const row=rows.get(level)??0;rows.set(level,row+1);
    return {...structuredClone(node),x:40+level*280,y:40+row*180};
  })};
}

export function duplicateScreenItem(screen: Screen, id: string, nextId:()=>string): Screen {
  validateScreen(screen);
  if(!screen.items.some(item=>item.id===id)) throw new Error('Choose an element to duplicate');
  const members=new Set([id]);
  for(let pass=0;pass<screen.items.length;pass++) for(const item of screen.items) if(item.groupId && members.has(item.groupId)) members.add(item.id);
  const ids=new Map([...members].map(member=>[member,nextId()]));
  const copies=screen.items.filter(item=>members.has(item.id)).map(item=>({...structuredClone(item),id:ids.get(item.id)!,label:copyLabel(item.label),x:shifted(item.x),y:shifted(item.y),...(item.groupId?{groupId:ids.get(item.groupId)??item.groupId}:{})}));
  return validateScreen({...screen,items:[...screen.items,...copies]});
}

export function snapScreen(screen: Screen, grid=20): Screen {
  if(!Number.isInteger(grid)||grid<1||grid>100) throw new Error('Grid must be an integer from 1 to 100');
  return validateScreen({...screen,items:screen.items.map(item=>({...item,x:Math.max(-100000,Math.min(100000,Math.round(item.x/grid)*grid)),y:Math.max(-100000,Math.min(100000,Math.round(item.y/grid)*grid))}))});
}
