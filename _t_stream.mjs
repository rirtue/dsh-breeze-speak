import { readFileSync } from 'node:fs';
process.env.DSH_HOME = 'C:/Users/Administrator/.dsh';
const mod = await import('./index.js');

const routes = {};
const marks = [];
let t0 = Date.now();
const ctx = {
  logger: { info(){}, warn: (m)=>console.log('[warn]', m), error(){} },
  effect: (fn) => { const d = fn(); return () => {}; },
  on: () => () => {},            // llm/stream 钩子，这里不需要
  webServer: { register: (r) => { routes[r.path] = r.handler; return () => {}; } },
};

mod.apply(ctx);
await new Promise(r => setTimeout(r, 200));
console.log('已注册路由:', Object.keys(routes).join(', '));

const sseClient = {
  writeHead(){},
  write(chunk){
    const s = chunk.toString();
    if (s.startsWith('event: pcm\n')) marks.push({ at: Date.now()-t0, kind:'pcm' });
    else if (s.startsWith('event: audio\n')) marks.push({ at: Date.now()-t0, kind:'audio-mp3' });
    else if (s.startsWith('event: pcm-end')) marks.push({ at: Date.now()-t0, kind:'pcm-end' });
  },
  on(){},
};
routes['/dsh-breeze-speak/stream']({}, sseClient);
await new Promise(r => setTimeout(r, 50));

t0 = Date.now();
const req = { [Symbol.asyncIterator]: async function*(){ yield Buffer.from(JSON.stringify({ text: '哼，才不是特意为你念的呢！', voiceId: 'voc_u3nxkd5578wc' })); } };
const res = { writeHead(){}, end(b){ this.body = b; } };
await routes['/dsh-breeze-speak/preview'](req, res);
console.log('preview 响应:', String(res.body).slice(0, 120));

await new Promise(r => setTimeout(r, 9000));

console.log('\n=== 时序（相对发起合成）===');
const pcms = marks.filter(m=>m.kind==='pcm');
pcms.forEach((m,i) => { if (i<3 || i>=pcms.length-2) console.log(`  ${String(m.at).padStart(5)}ms  pcm#${i+1}`); });
const others = marks.filter(m=>m.kind!=='pcm');
others.forEach(m => console.log(`  ${String(m.at).padStart(5)}ms  ${m.kind}`));
console.log(`\n共 ${pcms.length} 个 PCM 帧`);
if (pcms.length) console.log(`✅ 第一声（首帧音频）: ${pcms[0].at}ms   ← 改之前是 ~2100ms`);
else console.log('❌ 没收到 pcm');
