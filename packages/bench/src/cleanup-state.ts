/** A graph can retain its historical fault after an explicit stop; device stop must be confirmed. */
export function confirmedStopped(path:string,state:unknown):boolean {
  return state==='stopped' || (state==='faulted' && /^\/api\/v1\/graphs\/[^/]+\/runtime$/.test(path));
}
