import { describe,it,expect } from 'vitest';
import { duplicateGraphNode, arrangeGraph, duplicateScreenItem, snapScreen } from './editor-tools.js';
import type { LogicGraph } from './logic.js';
import { validateScreen, type Screen } from './screen.js';

describe('reversible editor actions',()=>{
  it('duplicates a graph block with independent settings without inventing output connections',()=>{
    const graph:LogicGraph={schemaVersion:1,nodes:[{id:'a',kind:'constant',label:'Power',x:10,y:20,value:true},{id:'b',kind:'not',label:'Invert',x:200,y:20}],edges:[{id:'ab',source:'a',target:'b',port:'in'}]};
    const next=duplicateGraphNode(graph,'a','copy');
    expect(next.nodes[2]).toMatchObject({id:'copy',label:'Power copy',x:50,y:60,value:true});
    expect(next.edges).toEqual(graph.edges); expect(graph.nodes).toHaveLength(2);
    expect(()=>duplicateGraphNode(graph,'a','b')).toThrow();
  });
  it('arranges blocks by dependency while preserving graph behavior and identity',()=>{
    const graph:LogicGraph={schemaVersion:1,nodes:[{id:'b',kind:'not',label:'Invert',x:0,y:0},{id:'a',kind:'constant',label:'Power',x:0,y:0,value:true}],edges:[{id:'ab',source:'a',target:'b',port:'in'}]};
    const next=arrangeGraph(graph);expect(next.nodes.find(n=>n.id==='b')!.x).toBeGreaterThan(next.nodes.find(n=>n.id==='a')!.x);
    expect(next.edges).toEqual(graph.edges);expect(graph.nodes[0]!.x).toBe(0);
  });
  it('duplicates a group subtree with new IDs and remapped memberships, then snaps without changing bindings',()=>{
    const scene:Screen={schemaVersion:1,width:1000,height:800,items:[{id:'group',kind:'group',label:'Panel',x:13,y:17,width:400,height:300},{id:'lamp',kind:'indicator',label:'Lamp',signalId:'signal',groupId:'group',x:23,y:47,width:100,height:80}]};
    let counter=0;const next=duplicateScreenItem(scene,'group',()=>`copy-${++counter}`);
    expect(next.items).toHaveLength(4); expect(next.items[3]).toMatchObject({signalId:'signal',groupId:'copy-1'});
    expect(next.items[2]!.x).toBe(53);expect(scene.items).toHaveLength(2);validateScreen(next);
    const snapped=snapScreen(next,20);expect(snapped.items.every(n=>n.x%20===0&&n.y%20===0)).toBe(true);expect(snapped.items[3]!.signalId).toBe('signal');
    expect(()=>snapScreen(scene,0)).toThrow();
  });
});
