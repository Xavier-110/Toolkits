export const pages=['convert','configs','versions','cert','environments','backup','users','settings'];
export function readRoute(hash,role) {
  const [raw,query='']=hash.replace(/^#/,'').split('?'),params=new URLSearchParams(query);
  const denied=['backup','users'].includes(raw)&&role!=='admin';
  const invalid=!!raw&&!pages.includes(raw);
  const state={page:denied||invalid?'convert':raw||'convert',denied,invalid};
  for(const key of ['id','regionId','environmentTypeId','configNameId'])state[key]=params.get(key)||'';
  return state;
}
export function routeHash(page,values={}) {
  const params=new URLSearchParams();
  for(const key of ['id','regionId','environmentTypeId','configNameId'])if(values[key])params.set(key,values[key]);
  return `#${page}${params.size?'?'+params:''}`;
}
