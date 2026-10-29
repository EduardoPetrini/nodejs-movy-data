-- What a new runner of each class could take on right now: the one definition
-- of demand, read by KEDA (as `movy_scaler`) and by Compose's auto mode alike,
-- so the two can never disagree about it.
--
-- A queued run waiting only on its destination is NOT demand: a new runner
-- would wait on the same lock. Queued probes are, or a Test "from large" could
-- never wake a Job class that has no runner up.
--
-- A class name and two counts, never an org, a run or a destination. It runs
-- with its owner's rights (security_invoker is off), so the scaler role reads
-- it with no grant on `runs` or `runner_probes` at all.
CREATE VIEW runner_demand AS
SELECT c.name AS runner_class,
       (SELECT count(*) FROM runs q
         WHERE q.status = 'queued' AND q.runner_class = c.name
           AND (q.target_lock_key IS NULL OR NOT EXISTS (
                 SELECT 1 FROM runs b WHERE b.target_lock_key = q.target_lock_key
                    AND b.status IN ('running', 'cancelling'))))::int AS claimable_runs,
       (SELECT count(*) FROM runner_probes p
         WHERE p.runner_class = c.name AND p.status = 'queued'
           AND p.expires_at > now())::int AS queued_probes
  FROM runner_classes c
 WHERE c.configured;
