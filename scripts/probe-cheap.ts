import { cheapComplete } from '../src/hydration/cheap.js';
import { closePool } from '../src/db/index.js';

/**
 * Probes the cheap-completion path.
 *
 * Exists because a null return from cheapComplete is indistinguishable from
 * "the model found nothing" at the call site — both surface as an empty
 * result. That ambiguity hid a broken hosted-tier call behind what looked like
 * clean, precise extraction.
 */
const sample = `
User: I've been going back and forth on where to host the Minecraft server.
Assistant: What are you weighing?
User: Self-hosting on the home PC versus Exaroton. I'm going with Exaroton — I don't
want the box pinned when I'm using it for other things, and their pause-when-empty
billing means it costs almost nothing on quiet weeks. Decided.
`;

const prompt = `Extract DECISIONS from the text below. Return ONLY a JSON array with
objects having "statement", "rationale", "topic", "confidence". Empty array if none.

TEXT:
${sample}`;

console.log('--- local tier ---');
const local = await cheapComplete(prompt, { maxChars: 8000 });
console.log(local === null ? 'NULL (call failed)' : local.slice(0, 300));

console.log('\n--- quality tier (preferQuality) ---');
const quality = await cheapComplete(prompt, { maxChars: 8000, preferQuality: true });
console.log(quality === null ? 'NULL (call failed)' : quality.slice(0, 300));

await closePool();
