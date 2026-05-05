-- M2: rewrite legacy {architect,developer,qa} rolesJson into the new {roles:[...]} array shape.
-- Idempotent: only fires on rows still in the old shape.
UPDATE teams
SET roles_json = json_object(
  'roles', json_array(
    json_extract(roles_json, '$.architect'),
    json_extract(roles_json, '$.developer'),
    json_extract(roles_json, '$.qa')
  )
)
WHERE json_extract(roles_json, '$.architect') IS NOT NULL
  AND json_extract(roles_json, '$.roles') IS NULL;
