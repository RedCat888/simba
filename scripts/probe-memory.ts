import { query, one, closePool } from '../src/db/index.js';
import { buildHydrationBrief } from '../src/hydration/bundle.js';

const a = await one<{ id: string; slug: string }>(`SELECT id, slug FROM agents WHERE slug='simba'`);
const brief = await buildHydrationBrief(a!.id, {});
const hasSection = /## What you already know/.test(brief);
const hasFact = /no "simba" role|no `simba` role|role does not exist/i.test(brief);
console.log('agent           ', a!.slug);
console.log('memory section  ', hasSection ? 'present' : 'MISSING');
console.log('a real fact     ', hasFact ? 'present' : 'MISSING');
console.log('brief size      ', brief.length, 'chars');
const mem = await query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_memory`);
console.log('entries         ', mem[0]?.n);
await closePool();
process.exit(0);
