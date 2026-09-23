import {randomUUID} from 'node:crypto';
export const initial='Initial-Password-123',password='Changed-Password-456';
export async function seed(service){
  const auth=service.auth;await auth.bootstrap('admin',initial);let session=await auth.login('admin',initial);await auth.changePassword(session.token,initial,password);session=await auth.login('admin',password);
  const command=async(type,data,extra={})=>(await service.workspace.execute(session.user,{type,data,...extra})).result;
  const regions=[];for(const code of ['east','west'])regions.push((await command('dictionary',{kind:'regions',code,label:code})).id);
  const environmentTypeId=(await command('dictionary',{kind:'environmentTypes',code:'prod',label:'生产'})).id,configNameId=(await command('dictionary',{kind:'configNames',code:'app',label:'应用配置'})).id;
  const configs=[];
  for(const regionId of regions){const identity={regionId,environmentTypeId,configNameId};await command('binding',{...identity,enabled:true});const payload=n=>({...identity,jsonContent:JSON.stringify({APP_NAME:'my-service',isSupport:true,PORT:n,PASSWORD:'secret-'+n}),fieldDescriptions:{'/APP_NAME':'服务名称'},itemMetadata:{},description:'',tags:[],note:'fixture',requestId:randomUUID()});const first=await command('save',payload(80));const second=await command('save',payload(regionId===regions[0]?81:82),{id:first.configId,expectedRevision:1});configs.push({id:first.configId,first:first.version,latest:second.version,identity});}
  for(const role of ['operate','readonly']){await auth.createUser(session.user.id,{username:role,password:initial,role});const first=await auth.login(role,initial);await auth.changePassword(first.token,initial,password);}
  return {session,regions,environmentTypeId,configNameId,configs,command};
}
