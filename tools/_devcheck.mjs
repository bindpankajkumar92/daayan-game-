// One-off: does the dev server hand every module of the changed path over intact?
const BASE = 'http://127.0.0.1:5174';
const html = await (await fetch(BASE + '/')).text();
const m = /<script[^>]*src="([^"]+)"/.exec(html);
const files = [m ? m[1] : '/src/main.ts', '/src/world/HouseRooms.ts', '/src/world/HouseLayout.ts', '/src/world/HouseBuilder.ts', '/src/scenes/HouseScene.ts', '/src/player/FPController.ts'];
const out = [`entry: ${m ? m[1] : '(none)'}`, `index.html bytes: ${html.length}`];
for (const f of files) {
  const r = await fetch(BASE + (f.startsWith('/') ? f : '/' + f));
  const t = await r.text();
  const bad = /Transform failed|Failed to resolve|Pre-transform error|Internal server error/i.test(t.slice(0, 600));
  out.push(`${f} -> ${r.status}  bytes=${t.length}  ${r.status === 200 ? (bad ? '<-- ERROR TEXT' : 'ok') : '<-- NOT 200'}`);
  if (r.status !== 200 || bad) out.push('   ' + t.slice(0, 300).replace(/\n/g, ' '));
}
console.log(out.join('\n'));
