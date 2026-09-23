import {$,el,button,label,select,panel,heading,notify,dialog,download,time} from './online-ui.js';
const typeName={sqlite:'本地 SQLite',mysql:'MySQL',postgres:'PostgreSQL',oracle:'Oracle'};
export function renderSettingsPage({repo}){
  const admin=repo.user.role==='admin',generation=repo.generation,host=panel(el('p',{text:'正在读取存储设置…'})),days=el('input',{id:'settings-expiry-days',type:'number',min:0,max:3650,value:repo.state.settings.expiryWarningDays,disabled:!admin});
  $('page-settings').replaceChildren(heading('设置',admin?'管理共享设置与配置数据存储':'当前账号仅可查看非敏感设置摘要'),panel(label('证书提前预警天数',days),...(admin?[button('保存设置',async()=>{await repo.command({type:'settings',data:{expiryWarningDays:Number(days.value)}});notify('设置已更新');},'save-settings')]:[])),host);
  repo.request(admin?'/admin/storage':'/storage-summary').then(info=>{
    if(generation!==repo.generation||!host.isConnected)return;
    $('storage-status').textContent=typeName[info.type]||'服务端存储';
    host.replaceChildren(el('h2',{text:'配置数据存储'}),el('p',{text:`当前：${typeName[info.type]} · ${info.status==='ready'?'可用':'迁移中'}`}));
    if(!admin)return;
    let config={...(info.connection||{type:'sqlite'})},requestId=info.pendingMigration?.requestId||crypto.randomUUID();
    const mode=select('storage-mode',[{id:'sqlite',label:'本地存储（服务端 SQLite）'},{id:'database',label:'数据库存储'}],info.type==='sqlite'?'sqlite':'database',null),types=select('database-type',['mysql','oracle','postgres'].map(id=>({id,label:typeName[id]})),info.type==='sqlite'?'mysql':info.type,null),summary=el('p',{id:'storage-connection-summary',class:'notice'});
    const draw=()=>{types.parentElement.hidden=mode.value!=='database';summary.textContent=info.pendingMigration?`存在未完成迁移，目标 ${typeName[info.pendingMigration.type]}。点击“重试迁移”，将核验两侧数据后继续。`:mode.value==='sqlite'?'保存后迁移到新的本地 SQLite 文件，保留原存储。':config.type===types.value&&config.host?`${typeName[config.type]} · ${config.host}:${config.port} · ${config.database||config.serviceName} · ${config.username} · 密码不回显`:'请填写数据库连接信息';};
    const connectionDialog=async()=>{
      const previousType=config.type,type=types.value,previous=config.type===type?config:{type};
      const hostInput=el('input',{id:'db-host',value:previous.host||'',required:true,placeholder:'数据库主机名或IP'}),port=el('input',{id:'db-port',type:'number',min:1,max:65535,value:previous.port||({mysql:3306,postgres:5432,oracle:1521}[type])}),database=el('input',{id:'db-database',value:previous.database||previous.serviceName||'',required:true}),username=el('input',{id:'db-username',value:previous.username||'',required:true,autocomplete:'off'}),password=el('input',{id:'db-password',type:'password',autocomplete:'new-password',placeholder:info.type===type&&info.connection.passwordSet?'留空保留已有密码':'连接密码'}),tls=el('input',{id:'db-tls',type:'checkbox',checked:previous.tls!==false});
      if(!await dialog(`${typeName[type]} 连接信息`,[label('主机',hostInput),label('端口',port),label(type==='oracle'?'Service name':'数据库名称',database),label('用户名',username),label('密码',password),label('启用 TLS 并校验证书',tls)])){if(previousType!=='sqlite')types.value=previousType;draw();return false;}
      config={type,host:hostInput.value.trim(),port:Number(port.value),[type==='oracle'?'serviceName':'database']:database.value.trim(),username:username.value.trim(),password:password.value,tls:tls.checked};requestId=crypto.randomUUID();draw();return true;
    };
    const connection=()=>mode.value==='sqlite'?{type:'sqlite'}:Object.fromEntries(Object.entries({...config,type:types.value}).filter(([key])=>key!=='passwordSet'));
    const test=button('测试连接',async()=>{if(mode.value==='database'&&(!config.host||config.type!==types.value)&&!await connectionDialog())return;test.disabled=true;try{const response=await repo.request('/admin/storage/test','POST',connection());notify(response.message||'连接测试成功');}finally{test.disabled=false;}},'test-storage');
    const save=button(info.pendingMigration?'重试迁移':'保存并迁移',async()=>{
      if(!info.pendingMigration&&mode.value==='database'&&(!config.host||config.type!==types.value)&&!await connectionDialog())return;
      if(!await dialog('确认迁移配置数据',[el('p',{text:`将配置、版本、tag、环境枚举、用户和设置迁移至 ${typeName[info.pendingMigration?.type||connection().type]}。目标必须为空；校验成功后启用，原数据保留。期间短暂暂停写入，成功后需要重新登录。`})]))return;
      save.disabled=true;try{await repo.request('/admin/storage/migrate','POST',{connection:connection(),requestId,expectedRevision:info.revision});notify('存储已切换，请重新登录');repo.clear();}catch(error){notify(error.message,true);}finally{save.disabled=false;}
    },'save-storage',{class:'primary'});
    mode.onchange=()=>{requestId=crypto.randomUUID();draw();};types.onchange=()=>connectionDialog().catch(e=>notify(e.message,true));
    host.append(label('存储方式',mode),label('数据库类型',types),summary,el('div',{class:'row'},button('填写连接信息',connectionDialog,'edit-storage-connection'),test,save));
    if(info.pendingMigration){mode.disabled=types.disabled=test.disabled=true;$('edit-storage-connection').disabled=true;host.append(button('取消待完成迁移',async()=>{if(!await dialog('取消待完成迁移',[el('p',{text:'继续使用当前存储，仅取消迁移记录。已复制的目标数据完整保留，后续迁移仍须使用空目标。'})]))return;await repo.request('/admin/storage/cancel','POST',{requestId:info.pendingMigration.requestId,expectedRevision:info.revision});renderSettingsPage({repo});},'cancel-storage-migration'));}draw();
  }).catch(error=>{if(host.isConnected)host.replaceChildren(el('p',{class:'notice error',text:error.message}));});
}
export function renderBackupManagement({repo}){
  const host=panel(el('p',{text:'正在读取系统备份任务…'})),generation=repo.generation;$('page-backup').prepend(host);
  const draw=async()=>{
    const info=await repo.request('/admin/backups');if(generation!==repo.generation||!host.isConnected)return;
    const schedule=info.schedule,enabled=el('input',{id:'backup-enabled',type:'checkbox',checked:schedule.enabled}),at=el('input',{id:'backup-time',type:'time',value:schedule.time}),retain=el('input',{id:'backup-retain',type:'number',min:1,max:365,value:schedule.retain}),list=el('div',{id:'system-backup-list'});
    for(const file of info.files)list.append(el('div',{class:'row'},el('span',{text:`${time(file.createdAt)} · ${file.createdBy} · ${(file.size/1024).toFixed(1)} KiB · ${file.counts.configs} 配置 / ${file.counts.versions} 版本`}),button('下载系统备份',async()=>{if(!await dialog('下载完整系统备份',[el('p',{text:'包含配置原值和用户密码哈希，请妥善保存。恢复需停服并使用空目标。'})]))return;const data=await repo.request(`/admin/backups/${file.id}/download`);download(`ops-system-${file.id}.json`,JSON.stringify(data));},'',{dataset:{backupId:file.id}})));
    if(!info.files.length)list.append(el('p',{text:'暂无完整系统备份'}));
    const save=button('保存备份任务',async()=>{save.disabled=true;try{await repo.request('/admin/backup-schedule','PATCH',{enabled:enabled.checked,time:at.value,retain:Number(retain.value)});notify('备份任务已保存');await draw();}finally{save.disabled=false;}},'save-backup-schedule'),run=button('立即备份',async()=>{run.disabled=true;try{await repo.request('/admin/backups','POST',{});notify('完整系统备份已生成');await draw();}finally{run.disabled=false;}},'backup-now');
    host.replaceChildren(el('h2',{text:'完整系统备份'}),el('p',{class:'notice',text:'包含用户、配置与全部历史；不包含登录会话或数据库连接密码。服务运行时任务持续执行，关闭网页不影响。'}),el('div',{class:'row'},label('启用每日备份',enabled),label('每日时间',at),label('保留份数',retain),save,run),el('p',{text:`服务端时区：${info.timeZone} · 下次：${time(info.nextRun)} · 最近结果：${schedule.lastResult||'暂无'}${schedule.lastSuccessAt?' · 最近成功：'+time(schedule.lastSuccessAt):''}`}),list);
  };
  draw().catch(error=>{if(host.isConnected)host.replaceChildren(el('p',{class:'notice error',text:error.message}));});
}
