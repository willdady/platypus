-- Backfill provider.modelIds from a legacy string[] to per-model config objects
-- (issue #328). Each string id becomes { "id": <id>, "passthroughFileTypes": [...] }
-- with the passthrough set defaulted by provider type:
--   Anthropic / Google / Bedrock, and OpenAI on the Responses API → images + PDF
--   OpenAI chat-completions                                       → images only
--   OpenRouter (heterogeneous aggregator; many models text-only)  → none
--
-- Only rows still holding string elements are rewritten, so this is idempotent
-- and a no-op once every row is object-shaped. The backend also normalizes
-- either shape at read time, so an un-run migration (e.g. dev push) is harmless.
UPDATE "provider" p
SET "modelIds" = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', elem,
      'passthroughFileTypes',
      CASE
        WHEN p."provider_type" IN ('Anthropic', 'Google', 'Bedrock')
          THEN '["image/*","application/pdf"]'::jsonb
        WHEN p."provider_type" = 'OpenAI' AND p."api_mode" <> 'chat'
          THEN '["image/*","application/pdf"]'::jsonb
        WHEN p."provider_type" = 'OpenRouter'
          THEN '[]'::jsonb
        ELSE '["image/*"]'::jsonb
      END
    )
  )
  FROM jsonb_array_elements_text(p."modelIds") AS elem
)
WHERE jsonb_typeof(p."modelIds") = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p."modelIds") AS e
    WHERE jsonb_typeof(e) = 'string'
  );
