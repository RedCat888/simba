-- A lesson that cost an hour, written down once.
INSERT INTO skills (name, description, body, tags, source) VALUES
(
  'probing-which-model-really-ran',
  'Use when checking a CLI actually ran the model you configured.',
  E'# Finding out which model actually ran\n\n'
  'Configuring a model and getting that model are different things, and the gap '
  'is silent. Simba ran its top tier on the alias `opus` for weeks; it resolves '
  'to `claude-opus-4-7`, so the most capable agent in the system was a generation '
  'behind while the config looked right. `sonnet` had drifted to '
  '`claude-sonnet-4-6` the same way.\n\n'
  '## Rule 1: pin explicit ids, never aliases\n\n'
  'Aliases look like they track the latest model. They pin to whatever the CLI '
  'decided at some point, and the drift is invisible from outside. Exception: '
  '`haiku` currently resolves to `claude-haiku-4-5`, and pinning it would cause '
  'the opposite failure where a real upgrade never arrives.\n\n'
  '## Rule 2: read back what the CLI says it used\n\n'
  'The output shape differs by configuration, which matters:\n\n'
  '- Default config — an init event with `"model":"..."`\n'
  '- `CLAUDE_CONFIG_DIR` set to an isolated dir — **no init event at all**, only '
  'a result object. The model survives as a *key*: `"modelUsage":{"claude-opus-5":…}`\n\n'
  'Reading only `"model"` therefore finds nothing on exactly the isolated-account '
  'setup Simba uses.\n\n'
  '## Rule 3: the probe prompt changes the answer\n\n'
  'This is the trap. Claude Code recognises "reply with exactly X" as a trivial '
  'instruction-following pattern and serves it from a cheap path. Same account, '
  'same `--model claude-opus-5` flag:\n\n'
  '```\n'
  'hi                          -> claude-opus-5\n'
  'Say OK                      -> claude-opus-5\n'
  'Reply with exactly OK       -> claude-haiku-4-5   <-- routed away\n'
  'Reply with exactly OK and nothing else -> claude-haiku-4-5\n'
  '```\n\n'
  'Probe with **`Say OK`**. It keeps a deterministic answer to test against while '
  'still reaching the configured model.\n\n'
  '## Rule 4: one turn touches several models\n\n'
  'Claude runs background work on Haiku alongside the main model, so `modelUsage` '
  'holds more than one. Ask "does the model I configured appear anywhere in what '
  'was reported" — not "what was the first model". The weaker question false-alarms '
  'on every healthy Claude turn.\n\n'
  '## Run it\n\n'
  '```bash\n'
  'npx tsx scripts/probe-verify.ts claude-b claude-a cursor codex\n'
  '```',
  ARRAY['models','verification','claude','debugging'],
  'authored'
)
ON CONFLICT (name) DO NOTHING;
