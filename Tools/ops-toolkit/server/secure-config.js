import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,open} from 'node:fs/promises';
import {join} from 'node:path';
export class SecureConfig {
  constructor(directory){this.directory=directory;this.filename=directory&&join(directory,'storage-config.enc');this.keyname=directory&&join(directory,'storage-config.key');this.memory=null;}
  async key(create=false){
    try{const key=await readFile(this.keyname);if(key.length!==32)throw Error('存储引导密钥无效');return key;}
    catch(error){if(error.code!=='ENOENT'||!create)throw error;const key=randomBytes(32);try{await writeFile(this.keyname,key,{flag:'wx',mode:0o600});return key;}catch(error){if(error.code==='EEXIST')return this.key();throw error;}}
  }
  async read(){
    if(!this.directory)return this.memory;
    let bytes;try{bytes=await readFile(this.filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    try{const envelope=JSON.parse(bytes),decipher=createDecipheriv('aes-256-gcm',await this.key(),Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));}catch{throw Error('存储引导配置无法解密，请检查本机密钥；不会回退旧数据库');}
  }
  async write(value){
    if(!this.directory){this.memory=structuredClone(value);return;}
    await mkdir(this.directory,{recursive:true});const key=await this.key(true),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    const temp=this.filename+'.'+randomBytes(8).toString('hex')+'.tmp';
    const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));await handle.sync();}finally{await handle.close();}
    await rename(temp,this.filename);
  }
}
