import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
// Keep the reviewed install a single hash-pinned script.
const source=Buffer.from((await readFile(new URL('bridge/thread-messages.js',root),'utf8'))+'\n'+(await readFile(new URL('bridge/desktop-adapter.js',root),'utf8')).replace("import {createMessageReader} from './thread-messages.js';",''));
const hash=createHash('sha256').update(source).digest('hex');
const command=`void (async()=>{const response=await fetch('http://127.0.0.1:4781/desktop/adapter.js');if(!response.ok)throw Error('Bridge HTTP '+response.status);const source=await response.text();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source)))].map(n=>n.toString(16).padStart(2,'0')).join('');if(hash!==${JSON.stringify(hash)})throw Error('Adapter changed. Review it before installing.');const script=document.createElement('script');script.type='module';script.textContent=source+'\\ninstall().then(s=>console.log("THREADBOARD_STATUS "+JSON.stringify(s))).catch(e=>console.error("THREADBOARD_INSTALL_ERROR "+e.message));';document.head.append(script)})().catch(e=>console.error('THREADBOARD_LOAD_ERROR '+e.message))`;
await mkdir(new URL('output/',root),{recursive:true});
await writeFile(new URL('output/install-desktop.txt',root),'// Requires explicit approval of this inline adapter method.\n// Review bridge/desktop-adapter.js and bridge/thread-messages.js first. The SHA-256 check pins both files.\n// Uses existing T3 connections. No credentials leave T3.\n'+command+'\n');
console.log('Desktop adapter SHA-256:',hash);
