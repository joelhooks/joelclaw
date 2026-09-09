-- Explicit, additive install. Run with psql -v ON_ERROR_STOP=1 against the flowing-memory database.
-- Notifications are payload-free and become visible only after the source transaction commits.
BEGIN;

DO $install$
DECLARE
  function_oid oid;
  function_owner name;
  function_source text;
  marker constant text := 'joelclaw flowing-memory forwarder commit wake v1';
  projection_trigger_found boolean := false;
  scope_trigger_found boolean := false;
  trigger_row record;
BEGIN
  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'migration privilege absent: CREATE on schema public is required';
  END IF;
  IF to_regclass('public.fm_projection_commits') IS NULL
     OR to_regclass('public.fm_scope_heads') IS NULL THEN
    RAISE EXCEPTION 'required flowing-memory source tables are absent';
  END IF;

  SELECT proc.oid, owner.rolname, proc.prosrc
    INTO function_oid, function_owner, function_source
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
  JOIN pg_roles AS owner ON owner.oid = proc.proowner
  WHERE namespace.nspname = 'public'
    AND proc.proname = 'joelclaw_flowing_memory_notify_commit'
    AND proc.pronargs = 0;

  IF function_oid IS NULL THEN
    EXECUTE $sql$
      CREATE FUNCTION public.joelclaw_flowing_memory_notify_commit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        BEGIN
          IF pg_notification_queue_usage() < 0.5 THEN
            PERFORM pg_notify('flowing_memory_committed', '');
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END
      $function$
    $sql$;
    COMMENT ON FUNCTION public.joelclaw_flowing_memory_notify_commit() IS
      'joelclaw flowing-memory forwarder commit wake v1';
    SELECT proc.oid, owner.rolname, proc.prosrc
      INTO function_oid, function_owner, function_source
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    JOIN pg_roles AS owner ON owner.oid = proc.proowner
    WHERE namespace.nspname = 'public'
      AND proc.proname = 'joelclaw_flowing_memory_notify_commit'
      AND proc.pronargs = 0;
  ELSIF obj_description(function_oid, 'pg_proc') IS DISTINCT FROM marker
     OR function_source NOT LIKE '%pg_notification_queue_usage() < 0.5%'
     OR function_source NOT LIKE '%pg_notify(''flowing_memory_committed'', '''')%'
     OR function_source NOT LIKE '%RETURN OLD%'
     OR function_source NOT LIKE '%RETURN NEW%' THEN
    RAISE EXCEPTION 'refusing unexpected same-name notification function';
  END IF;

  IF NOT pg_has_role(current_user, function_owner, 'MEMBER') THEN
    RAISE EXCEPTION 'migration privilege absent: current role does not control notification function owner %', function_owner;
  END IF;

  FOR trigger_row IN
    SELECT relation.oid AS relation_oid, trigger.tgfoid, trigger.tgtype
    FROM pg_trigger AS trigger
    JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname = 'joelclaw_flowing_memory_projection_commit_wake'
  LOOP
    IF projection_trigger_found
       OR trigger_row.relation_oid <> 'public.fm_projection_commits'::regclass
       OR trigger_row.tgfoid <> function_oid
       OR trigger_row.tgtype <> 4 THEN
      RAISE EXCEPTION 'refusing unexpected same-name projection notification trigger';
    END IF;
    projection_trigger_found := true;
  END LOOP;
  IF NOT projection_trigger_found THEN
    CREATE TRIGGER joelclaw_flowing_memory_projection_commit_wake
      AFTER INSERT ON public.fm_projection_commits
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.joelclaw_flowing_memory_notify_commit();
  END IF;

  FOR trigger_row IN
    SELECT relation.oid AS relation_oid, trigger.tgfoid, trigger.tgtype
    FROM pg_trigger AS trigger
    JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname = 'joelclaw_flowing_memory_scope_head_wake'
  LOOP
    IF scope_trigger_found
       OR trigger_row.relation_oid <> 'public.fm_scope_heads'::regclass
       OR trigger_row.tgfoid <> function_oid
       OR trigger_row.tgtype <> 28 THEN
      RAISE EXCEPTION 'refusing unexpected same-name scope-head notification trigger';
    END IF;
    scope_trigger_found := true;
  END LOOP;
  IF NOT scope_trigger_found THEN
    CREATE TRIGGER joelclaw_flowing_memory_scope_head_wake
      AFTER INSERT OR UPDATE OR DELETE ON public.fm_scope_heads
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.joelclaw_flowing_memory_notify_commit();
  END IF;
END
$install$;

COMMIT;

SELECT json_build_object(
  'ok', true,
  'channel', 'flowing_memory_committed',
  'payload', '',
  'projectionTrigger', 'joelclaw_flowing_memory_projection_commit_wake',
  'scopeHeadTrigger', 'joelclaw_flowing_memory_scope_head_wake'
)::text AS commit_notification_install;
