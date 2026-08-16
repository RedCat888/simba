const base = 'http://127.0.0.1:8787';

async function hit(path) {
  try {
    const r = await fetch(base + path);
    const t = await r.text();
    console.log(`\n${path}  ${r.status}  ${t.slice(0, 500)}`);
  } catch (e) {
    console.log(`\n${path}  FAIL  ${e.message}`);
  }
}

await hit('/api/stats');
await hit('/api/find?q=simba');
await hit('/api/knowledge/search?q=simba');
await hit('/api/knowledge/sources');
await hit('/api/sessions');
