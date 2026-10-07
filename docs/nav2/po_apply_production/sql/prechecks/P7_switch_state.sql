-- P7 (read only). The state of the existing price fetch switches before the release. Paste the rows back. The four NAV2 switches do not exist yet, so they are not listed here.
select job_key, enabled, left(coalesce(disabled_reason, ''), 60) as reason_start
from public.ii_reference_job_control
order by job_key;
