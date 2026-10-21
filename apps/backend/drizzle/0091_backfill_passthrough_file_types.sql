-- Retire the Provider-type default for passthroughFileTypes (#1594, ADR-0039).
-- An empty list used to inherit a default by provider type; it now means the
-- model ingests nothing natively. Write the default each entry was inheriting
-- into every entry that declares none, so no Provider changes behaviour:
--   Anthropic / Google / Bedrock, and OpenAI on the Responses API → images + PDF
--   OpenAI chat-completions                                       → images only
--   anything else (OpenRouter)                                    → none
-- Bare-string entries (pre-0047 rows on a dev push) become objects too.
-- Entries that already declare types, and their order, are untouched.
UPDATE "provider" p
SET "modelIds" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(e.elem) = 'object'
        AND jsonb_array_length(COALESCE(e.elem -> 'passthroughFileTypes', '[]'::jsonb)) > 0
        THEN e.elem
      ELSE
        CASE WHEN jsonb_typeof(e.elem) = 'string'
          THEN jsonb_build_object('id', e.elem)
          ELSE e.elem
        END
        || jsonb_build_object(
          'passthroughFileTypes',
          CASE
            WHEN p."provider_type" IN ('Anthropic', 'Google', 'Bedrock')
              THEN '["image/*","application/pdf"]'::jsonb
            WHEN p."provider_type" = 'OpenAI' AND p."api_mode" <> 'chat'
              THEN '["image/*","application/pdf"]'::jsonb
            WHEN p."provider_type" = 'OpenAI'
              THEN '["image/*"]'::jsonb
            ELSE '[]'::jsonb
          END
        )
    END
    ORDER BY e.ord
  )
  FROM jsonb_array_elements(p."modelIds") WITH ORDINALITY AS e(elem, ord)
)
WHERE jsonb_typeof(p."modelIds") = 'array'
  AND jsonb_array_length(p."modelIds") > 0;
