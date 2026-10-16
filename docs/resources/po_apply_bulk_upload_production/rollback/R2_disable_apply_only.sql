-- R2 immediate stop switch: nobody can create drafts out of an upload any more. Uploads can still be previewed.
-- The application calls the server only twin first and the signed in function second, so BOTH must be revoked.
-- Revoking only the signed in function leaves the twin working. Fully reversible with R3.

revoke execute on function public.apply_resource_content_import_as_actor(uuid, uuid) from service_role;
revoke execute on function public.apply_resource_content_import(uuid) from authenticated, service_role;
