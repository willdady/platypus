-- The Provider request contract and the stored `modelIds` column now agree on
-- one shape: an array of resolved model-config objects. Bare strings were
-- backfilled by 0047 and entries missing `passthroughFileTypes` by 0091.
-- Refuse to carry a row that slipped past both instead of handing the backend
-- a row it can no longer read.
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*)
  INTO offending
  FROM "provider" p,
       jsonb_array_elements(p."modelIds") AS entry
  WHERE jsonb_typeof(entry) <> 'object'
     OR NOT (entry ? 'id')
     OR NOT (entry ? 'passthroughFileTypes');

  IF offending > 0 THEN
    RAISE EXCEPTION
      'provider.modelIds has % entry/entries that are not resolved model-config objects; re-run migrations 0047 and 0091 before upgrading',
      offending;
  END IF;
END
$$;
