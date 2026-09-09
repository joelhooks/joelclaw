-- Guarded rollback. Refuses to remove same-name objects not owned by this package.
BEGIN;

DO $rollback$
DECLARE
  function_oid oid;
  marker constant text := 'joelclaw flowing-memory forwarder commit wake v1';
  trigger_row record;
BEGIN
  SELECT proc.oid INTO function_oid
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
  WHERE namespace.nspname = 'public'
    AND proc.proname = 'joelclaw_flowing_memory_notify_commit'
    AND proc.pronargs = 0;

  IF function_oid IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (
          'joelclaw_flowing_memory_projection_commit_wake',
          'joelclaw_flowing_memory_scope_head_wake'
        )
    ) THEN
      RAISE EXCEPTION 'refusing same-name triggers without the owned notification function';
    END IF;
    RETURN;
  END IF;
  IF obj_description(function_oid, 'pg_proc') IS DISTINCT FROM marker THEN
    RAISE EXCEPTION 'refusing unexpected same-name notification function';
  END IF;

  FOR trigger_row IN
    SELECT trigger.tgname, trigger.tgfoid, relation.oid AS relation_oid
    FROM pg_trigger AS trigger
    JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname IN (
        'joelclaw_flowing_memory_projection_commit_wake',
        'joelclaw_flowing_memory_scope_head_wake'
      )
  LOOP
    IF trigger_row.tgfoid <> function_oid
       OR (
         trigger_row.tgname = 'joelclaw_flowing_memory_projection_commit_wake'
         AND trigger_row.relation_oid <> 'public.fm_projection_commits'::regclass
       )
       OR (
         trigger_row.tgname = 'joelclaw_flowing_memory_scope_head_wake'
         AND trigger_row.relation_oid <> 'public.fm_scope_heads'::regclass
       ) THEN
      RAISE EXCEPTION 'refusing unexpected same-name notification trigger %', trigger_row.tgname;
    END IF;
  END LOOP;

  IF to_regclass('public.fm_projection_commits') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS joelclaw_flowing_memory_projection_commit_wake
      ON public.fm_projection_commits;
  END IF;
  IF to_regclass('public.fm_scope_heads') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS joelclaw_flowing_memory_scope_head_wake
      ON public.fm_scope_heads;
  END IF;
  DROP FUNCTION public.joelclaw_flowing_memory_notify_commit();
END
$rollback$;

COMMIT;

SELECT json_build_object('ok', true, 'removed', 'flowing_memory_committed wake objects')::text
  AS commit_notification_rollback;
