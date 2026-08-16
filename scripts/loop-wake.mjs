// Session keep-working heartbeat. Prints a sentinel the agent loop watches for.
const prompt =
  'Continue Simba from the Claude Code transcript: polish the Claude-like web UI and Android app, keep Find/Memory search working, finish overlay/chat polish, do not stop or ask, then re-arm the next heartbeat.';

const ms = Number(process.argv[2] || 480_000);
await new Promise((r) => setTimeout(r, ms));
console.log(`AGENT_LOOP_WAKE_simba ${JSON.stringify({ prompt })}`);
