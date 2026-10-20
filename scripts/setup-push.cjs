const fs=require('fs');
const path='cloudflare/.dev.vars';
if(!fs.existsSync(path)) { console.error('Crea primero cloudflare/.dev.vars a partir del ejemplo.'); process.exit(1); }
let contents=fs.readFileSync(path,'utf8');
const hasPublic=/^VAPID_PUBLIC_KEY=\S+/m.test(contents);
const hasPrivate=/^VAPID_PRIVATE_KEY=\S+/m.test(contents);
if(hasPublic!==hasPrivate){console.error('Hay una pareja VAPID incompleta. Revísala antes de generar otras claves.');process.exit(1);}
if(!hasPublic){const keys=require('web-push').generateVAPIDKeys();contents=contents.replace(/^VAPID_(PUBLIC_KEY|PRIVATE_KEY)=.*\r?\n?/gm,'');contents+='\nVAPID_PUBLIC_KEY='+keys.publicKey+'\nVAPID_PRIVATE_KEY='+keys.privateKey+'\n';fs.writeFileSync(path,contents);}
console.log('Claves Web Push locales preparadas. Reinicia el Worker para cargarlas.');
