// Read-only public asset fetch. No wallet, relay, or chain connection is opened.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const fixture=JSON.parse(await readFile('docs/selene-release-fixture.json','utf8'));
const directory=resolve('var/selene-app');
await mkdir(directory,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [name,expected]of Object.entries(fixture.files)){
  assert.match(name,/^[\w.-]+$/);
  const target=resolve(directory,name);
  const cached=await readFile(target).catch(()=>null);
  if(cached&&hash(cached)===expected)continue;
  const url=name==='sql-wasm.wasm'?'https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/sql-wasm.wasm':
    name==='index.html'?'https://app.selene.cash/':name==='favicon.png'?'https://app.selene.cash/favicon.png':
      'https://app.selene.cash/assets/'+name;
  const response=await fetch(url,{signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('Cannot fetch pinned Selene file '+name+': '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes),expected,'Release content differs from pinned fixture: '+name);
  await writeFile(target+'.download',bytes);
  await rename(target+'.download',target);
  console.log('Cached '+name);
}
console.log('Pinned Selene release assets verified under var/selene-app.');
