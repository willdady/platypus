-- The Provider request contract and the stored `modelIds` column now agree on
-- one shape: an array of resolved model-config objects. Bare strings were
-- backfilled by 0047 and entries missing `passthroughFileTypes` by 0091.
-- Refuse to carry a row that slipped past both instead of handing the backend
-- a row it can no longer read.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(DISTINCT p."id", ', ')
  INTO offending
  FROM "provider" p,
       jsonb_array_elements(p."modelIds") AS entry
  WHERE jsonb_typeof(entry) <> 'object'
     OR NOT (entry ? 'id')
     OR NOT (entry ? 'passthroughFileTypes');

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'provider.modelIds is not resolved model-config objects for provider(s) %; open each Provider on your current version, re-save its models, then upgrade again',
      offending;
  END IF;
END
$$;
