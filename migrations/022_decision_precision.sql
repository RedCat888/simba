-- 022_decision_precision.sql
--
-- Retires extracted "decisions" that are actually problem-solving narration.
--
-- The corpus contains years of homework, and a model asked for decisions will
-- happily return "I'm integrating the series for f(t) term by term" — which is
-- a move inside one exercise, not something worth recalling in a year. The
-- extraction prompt has been tightened for future runs; this cleans what is
-- already stored.
--
-- Marked 'abandoned' rather than deleted: the extraction is evidence about how
-- the extractor behaves, and re-running would just recreate them. Abandoned
-- rows are excluded from recall and from the vault, but the row survives so the
-- heuristic can be reviewed.
--
-- Heuristics are chosen for precision over recall. Each one alone would have
-- false positives; a genuine decision almost never looks like ALL of this.

UPDATE decisions
   SET status = 'abandoned'
 WHERE status = 'current'
   AND (
     -- LaTeX in the statement means a worked derivation, essentially always.
     statement ~ '\$.*\$|\\\\frac|\\\\int|\\\\sum|\\\\begin\{'

     -- Narration of an in-progress step. "I'm starting with...", "For part (c)
     -- I'm using...". Anchored to the opening so it does not catch a real
     -- decision that merely happens to contain the phrase.
     OR statement ~* '^\s*(for part\s*\(?[a-e]\)?|i''m (starting|integrating|setting up|using|solving|working|plugging|substituting|taking|differentiating))'

     -- Explicit exercise scaffolding.
     OR statement ~* '^\s*(part\s*\(?[a-e]\)?|step\s*\d+|question\s*\d+)\b'
   );

-- Topics that are entirely narration after the above are not worth keeping as
-- browsable clusters either.
UPDATE decisions d
   SET status = 'abandoned'
 WHERE d.status = 'current'
   AND d.topic IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM decisions k
      WHERE k.topic = d.topic
        AND k.status = 'current'
        AND k.confidence IN ('acted_on', 'decided')
        AND k.statement !~ '\$.*\$|\\\\frac|\\\\int'
   );
