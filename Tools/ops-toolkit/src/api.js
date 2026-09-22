import { emptyState } from './store.js';
export class ApiRepository {
  constructor() {this.state=emptyState();this.user=null;this.csrf='';this.persistent=false;this.generation=0;}
  async request(path,method='GET',data) {
    const generation=this.generation;
    const response=await fetch('/api'+path,{method,credentials:'same-origin',cache:'no-store',headers:{...(data!==undefined?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{'X-CSRF-Token':this.csrf}:{})},body:data===undefined?undefined:JSON.stringify(data)});
    const result=await response.json();
    if(generation!==this.generation)throw Error('会话已切换，已丢弃旧请求结果');
    if(!response.ok){if(response.status===401&&path!=='/login')this.clear('expired');throw Object.assign(Error(result.error || '请求失败'),{status:response.status});}
    return result;
  }
  clear(reason='logout') {const previous=this.user;this.generation++;this.user=null;this.csrf='';this.persistent=false;this.state=emptyState();this.onLost?.(reason,previous);}
  async open() {const session=await this.request('/me');this.user=session.user;this.csrf=session.csrf;if(this.user.mustChangePassword)return;return this.reload();}
  async reload() {const generation=this.generation,state=await this.request('/workspace');if(generation!==this.generation)throw Error('会话已切换');this.state=state;this.persistent=true;return state;}
  async command(command) {
    if(!this.user || this.user.role==='readonly')throw Error('当前账号无写入权限');
    const generation=this.generation;
    const payload={...command,expectedRevision:command.expectedRevision ?? this.state.configs.find(c=>c.id===command.id)?.revision};
    const response=await this.request('/commands','POST',payload);
    if(generation!==this.generation)throw Error('会话已切换');
    this.state=response.state;return response.result;
  }
  backup(id='',redacted=false) {return this.request(`/backup?id=${encodeURIComponent(id)}&redacted=${redacted}`);}
}
