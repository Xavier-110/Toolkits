export function mountIdentity({repo,ready,lost,notify}) {
  const $=id=>document.getElementById(id);
  const gate=document.createElement('section');gate.id='account-gate';gate.className='account-gate';
  gate.innerHTML=`<div class="account-card panel"><div class="eyebrow">OPS TOOLKIT · 团队工作空间</div><h1>登录运维工具箱</h1><p class="muted">使用管理员为你开通的账号访问配置与版本。</p>
    <form id="login-form"><label>用户名<input id="login-username" autocomplete="username" required maxlength="64"></label><label>密码<input id="login-password" type="password" autocomplete="current-password" required maxlength="128"></label><button id="login-submit" class="primary">登录</button></form>
    <form id="password-form" hidden><h2>修改密码</h2><p>新密码须为 12～128 个字符，修改后请重新登录。</p><label>原密码<input id="old-password" type="password" autocomplete="current-password" required></label><label>新密码<input id="new-password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>确认新密码<input id="confirm-password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button id="password-submit" class="primary">修改密码</button><button id="password-cancel" type="button">退出并返回登录</button></form><p id="login-message" class="notice" role="status">请输入账号密码</p></div>`;
  document.body.append(gate);
  const account=document.createElement('div');account.className='account-actions';
  account.innerHTML='<span id="account-name" class="pill"></span><button id="change-password">修改密码</button><button id="logout">退出</button>';
  document.querySelector('.header-actions').prepend(account);
  const nav=document.createElement('button');nav.className='nav-item';nav.dataset.page='users';nav.textContent='♙ 用户管理';document.querySelector('nav').append(nav);
  const page=document.createElement('section');page.className='page';page.id='page-users';page.hidden=true;
  page.innerHTML=`<div class="page-heading"><div><div class="eyebrow">ACCESS MANAGEMENT</div><h1>用户与权限</h1><p>创建白名单账号，分配角色，随时启用或停用访问权限。</p></div></div>
    <form id="user-form" class="panel toolbar"><label>用户名<input id="user-name" required pattern="[a-zA-Z0-9_.-]{3,64}" autocomplete="off"></label><label>初始密码<input id="user-password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></label><label>角色<select id="user-role"><option value="readonly">readonly · 只读</option><option value="operate">operate · 操作</option><option value="admin">admin · 管理员</option></select></label><button id="user-create" class="primary">创建白名单用户</button></form>
    <div class="panel toolbar"><label class="grow">查找用户<input id="user-search" placeholder="按用户名搜索"></label><label>角色<select id="user-role-filter"><option value="">全部角色</option><option>admin</option><option>operate</option><option>readonly</option></select></label><label>状态<select id="user-status-filter"><option value="">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label><button id="users-refresh">刷新</button></div><div id="user-list" class="panel"></div>`;
  document.querySelector('main').insertBefore(page,document.querySelector('footer'));
  const message=(text,error=false)=>{$('login-message').textContent=text;$('login-message').className='notice'+(error?' error':'');};
  let users=[],busy=false;
  function gateMode(password=false) {document.body.dataset.session='locked';gate.hidden=false;$('login-form').hidden=password;$('password-form').hidden=!password;}
  async function enter() {
    if(repo.user.mustChangePassword){gateMode(true);message('首次登录或密码已重置，请先修改密码。');return;}
    await repo.reload();await ready();
    document.body.dataset.role=repo.user.role;document.body.dataset.session='ready';gate.hidden=true;
    $('account-name').textContent=`${repo.user.username} · ${repo.user.role}`;nav.hidden=repo.user.role!=='admin';
  }
  repo.onLost=(reason,previous)=>{
    users=[];$('user-list').replaceChildren();$('account-name').textContent='';document.body.dataset.role='';
    for(const f of gate.querySelectorAll('form'))f.reset();$('user-form').reset();lost(reason,previous);gateMode();
    message(reason==='expired'?'会话已失效，请重新登录。':'已退出登录');
  };
  async function run(button,fn){if(busy)return;busy=true;button.disabled=true;try{await fn();}catch(e){message(e.message,true);notify(e.message,true);}finally{busy=false;button.disabled=false;}}
  $('login-form').addEventListener('submit',e=>{e.preventDefault();run($('login-submit'),async()=>{
    const session=await repo.request('/login','POST',{username:$('login-username').value,password:$('login-password').value});
    repo.user=session.user;repo.csrf=session.csrf;$('login-password').value='';await enter();
  });});
  $('password-form').addEventListener('submit',e=>{e.preventDefault();run($('password-submit'),async()=>{
    if($('new-password').value!==$('confirm-password').value)throw Error('两次新密码不一致');
    await repo.request('/password','POST',{oldPassword:$('old-password').value,password:$('new-password').value});repo.clear();message('密码已修改，请使用新密码登录。');
  });});
  async function logout(){await repo.request('/logout','POST',{});repo.clear();}
  $('logout').onclick=()=>run($('logout'),logout);$('password-cancel').onclick=()=>run($('password-cancel'),logout);
  $('change-password').onclick=()=>{gateMode(true);message('修改后全部旧会话会失效。');};
  async function refresh(){users=await repo.request('/users');renderUsers();}
  function renderUsers(){
    $('user-list').replaceChildren();
    for(const user of users.filter(u=>u.username.toLowerCase().includes($('user-search').value.toLowerCase())&&(!$('user-role-filter').value||u.role===$('user-role-filter').value)&&(!$('user-status-filter').value||u.enabled===($('user-status-filter').value==='enabled')))){
      const row=document.createElement('div');row.className='user-row';
      const name=document.createElement('strong');name.textContent=user.username;
      const status=document.createElement('span');status.className='pill';status.textContent=user.enabled?'已启用':'已停用';
      const role=document.createElement('select');role.setAttribute('aria-label',`${user.username} 的角色`);
      for(const value of ['admin','operate','readonly']){const option=document.createElement('option');option.value=option.textContent=value;role.append(option);}role.value=user.role;
      const apply=document.createElement('button');apply.textContent='保存角色';
      const toggle=document.createElement('button');toggle.textContent=user.enabled?'停用':'启用';
      const password=document.createElement('input');password.type='password';password.placeholder='新的初始密码';password.autocomplete='new-password';password.setAttribute('aria-label',`${user.username} 的重置密码`);
      const reset=document.createElement('button');reset.textContent='重置密码';
      const patch=async data=>{await repo.request(`/users/${user.id}`,'PATCH',data);if(user.id===repo.user?.id){repo.clear();return;}password.value='';await refresh();notify('用户已更新，旧会话已撤销');};
      apply.onclick=()=>run(apply,()=>patch({role:role.value}));toggle.onclick=()=>run(toggle,()=>patch({enabled:!user.enabled}));reset.onclick=()=>run(reset,()=>patch({password:password.value}));
      row.append(name,status,role,apply,toggle,password,reset);$('user-list').append(row);
    }
  }
  $('user-form').onsubmit=e=>{e.preventDefault();run($('user-create'),async()=>{await repo.request('/users','POST',{username:$('user-name').value,password:$('user-password').value,role:$('user-role').value});$('user-form').reset();await refresh();notify('白名单用户已创建');});};
  for(const id of ['user-search','user-role-filter','user-status-filter'])$(id).addEventListener(id==='user-search'?'input':'change',renderUsers);
  $('users-refresh').onclick=()=>run($('users-refresh'),refresh);
  nav.onclick=async()=>{try{await window.opsNavigate('users');await refresh();}catch(e){notify(e.message,true);}};
  async function check(){
    if(!repo.user||busy)return;
    try{const session=await repo.request('/me');if(session.user.id!==repo.user?.id||session.user.role!==repo.user?.role)repo.clear('expired');}catch(e){if(e.status!==401)notify('连接中断，请检查网络',true);}
  }
  setInterval(check,15000);window.addEventListener('focus',check);
  gateMode();repo.open().then(()=>repo.user&&enter()).catch(e=>{if(e.status!==401)message(e.message,true);});
}
