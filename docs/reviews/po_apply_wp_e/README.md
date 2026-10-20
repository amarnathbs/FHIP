# WP-E PO pack

Only one file, and it is READ ONLY: `01_READ_ONLY_find_the_failed_bank_import.sql`. It changes nothing on production or DEV.

Why you may want it: F15 (the bank-statement import that says "extracting transactions" and then "We could not process this bank statement") was reproduced on DEV
and its cause measured there, but production's own record of YOUR failed upload is the only proof of which stage it stopped at. Paste the result of block 1 and block 2
(they hold no statement content) into the chat and it settles whether the stop was the 28 second platform limit, the safety check, the account assignment, or something else.

No migration is part of WP-E (range 0310-0311 unused).
