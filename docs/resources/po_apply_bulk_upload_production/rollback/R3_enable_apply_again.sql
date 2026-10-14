-- R3 undo of R2: gives back exactly the privileges 0272 and 0273 set.

grant execute on function public.apply_resource_content_import(uuid) to authenticated, service_role;
grant execute on function public.apply_resource_content_import_as_actor(uuid, uuid) to service_role;
