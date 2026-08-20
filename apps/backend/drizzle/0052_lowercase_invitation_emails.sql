UPDATE "invitation"
SET "email" = lower("email")
WHERE "email" <> lower("email");
