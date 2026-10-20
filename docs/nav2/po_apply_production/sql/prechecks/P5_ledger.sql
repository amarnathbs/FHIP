-- P5 (read only). The migration ledger, if this project keeps one. Many hand applied migrations are not recorded here, so an EMPTY or MISSING ledger is not a problem.
-- If the editor says the relation does not exist, that is an acceptable answer. Paste back whatever it shows.
select version, name
from supabase_migrations.schema_migrations
where version >= '0250'
order by version;
