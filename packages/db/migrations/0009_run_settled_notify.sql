-- Every settlement of a run is announced on `movy_run_settled`, whoever wrote it.
--
-- A run settled with no event of its own — a fenced or crashed runner, a spec
-- that could not be read, a run found dead on re-attach — reaches a watching
-- browser only through this notification: nothing else is on the run's event
-- stream. Sending it from each statement that settles a run left every path but
-- the sweeper's silent, and the page said "running" forever. A trigger makes
-- the rule structural: a settlement written tomorrow, by code that has never
-- heard of this channel, is announced too.
--
-- The payload is a pointer, as on every channel: the console re-reads the row.
-- Delivered only on commit, so nobody reads a status that is not there yet.
CREATE FUNCTION movy_announce_run_settled() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('movy_run_settled', json_build_object('runId', NEW.id)::text);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_settled_notify
  AFTER UPDATE OF status ON runs
  FOR EACH ROW
  WHEN (NEW.status IN ('succeeded', 'failed', 'cancelled')
        AND OLD.status NOT IN ('succeeded', 'failed', 'cancelled'))
  EXECUTE FUNCTION movy_announce_run_settled();
