-- 023_decision_voice.sql
--
-- Retires "decisions" that are actually the assistant talking.
--
-- A transcript has two speakers, and an extractor asked for decisions will pull
-- the assistant's advice, its announcements of its own next step, and plain
-- facts it stated — none of which are the person's decisions:
--
--   "The user should confirm that their 2FA is app-based"   <- advice
--   "I will check UT Dallas's payment deadlines"            <- assistant's step
--   "Your tuition is due Thursday, September 3, 2026"       <- a fact
--
-- The tell is grammatical person. A decision is in the person's own voice about
-- their own choice; anything addressed TO them is not one. Matched narrowly so a
-- genuine first-person decision that happens to mention "you" survives.

UPDATE decisions
   SET status = 'abandoned'
 WHERE status = 'current'
   AND (
     -- Second person as the subject: advice or a statement about them.
     statement ~* '^\s*(you|your|the user)\b'
     OR statement ~* '^\s*[A-Z][^.]{0,60},\s*your\b'

     -- Assistant announcing its own action, as opposed to the person's.
     OR statement ~* '^\s*i (will|can|should|could) (check|look|verify|confirm|search|find|review|see)\b'

     -- Prescriptive advice rather than a settled choice.
     OR statement ~* '\b(you should|you must|you need to|you can enroll|make sure you)\b'
   );
