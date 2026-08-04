-- Tier 1 does the real work, so tier 1 gets the strongest model.
--
-- Corrected on the owner's instruction: the tier-1 domain agents are the
-- primary entities that write code and act on the machine, with tier 0 acting
-- as their scouting, research and task-shaping layer rather than the other way
-- round.
--
-- The configuration contradicted that. Tier-1 agents ran on 'mid'
-- (claude-sonnet-5) and one on 'cheap', while tier 0 alone had 'high'
-- (claude-opus-5). So the agents doing the actual work had the weaker model and
-- the layer scouting for them had the stronger one — exactly inverted.
--
-- Tier 0 keeps 'high' too. It is the surface the user talks to and the standing
-- requirement is that Simba runs on Opus; scouting well is not a cheap task
-- either. The point of this change is raising tier 1, not lowering tier 0.
--
-- Tier 2 stays 'free'. Those are bulk unattended workers and the free brain has
-- now built a real Android APK end to end without costing anything, so there is
-- evidence rather than hope behind that.
UPDATE agents
   SET model_tier = 'high',
       updated_at = now()
 WHERE tier = 1
   AND retired_at IS NULL;
