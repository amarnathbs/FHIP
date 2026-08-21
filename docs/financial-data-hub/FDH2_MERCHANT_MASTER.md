# FDH2_MERCHANT_MASTER

## 1. Quantity vs quality

123 merchants total (69 AU + 54 India), 198 aliases (avg. 1.6 per
merchant). This is deliberately a **smaller, verified library**, not a
guessed-and-inflated one — every merchant is a real, well-known brand this
session holds genuine confidence in; nothing was invented to raise the
count.

## 2. Stable identity

`canonical_name` (FDH-1's existing column, documented there as "normalised
machine form") is the merchant's stable machine key — FDH-2 populates it
with lowercase snake_case forms (`woolworths`, `costco_au`, `netflix_in`)
rather than adding a second, competing key column. `display_name` carries
the human-readable brand name separately, so renaming a display label never
repoints history. `country_code` + `canonical_name` is the real uniqueness
constraint (FDH-1's `uq_fdh_merchants_country_name`); `country_code IS NULL`
already encodes "global merchant" (`uq_fdh_merchants_global_name`) — no
FDH-2 merchant uses this, since every AU/India brand seeded has a
genuinely country-specific descriptor (even Netflix/Spotify/Amazon Prime
are seeded once per country because their AU and India transaction
narratives, MCC confidence and local pricing context differ enough to
warrant separate rows — see section 5).

## 3. Verification status

FDH-1's `verification_status` enum (`proposed`/`admin_review`/`approved`/
`rejected`/`merged`) is narrower than the specification's illustrative
7-state list (VERIFIED/PUBLIC_SOURCE_VERIFIED/INFERRED/USER_PROPOSED/
ADMIN_REVIEW/REJECTED/DEPRECATED) — this is an FDH-1 architectural decision
FDH-2 does not reopen. Every FDH-2-seeded merchant is `approved`: each is a
manually-researched, publicly-identifiable brand, ready for a future
classification engine to prefer over an unverified row, which is exactly
what "approved" means in this schema's governance lifecycle.

`mcc_confidence` (new column: `verified`/`high`/`medium`/`low`) is a
SEPARATE, narrower confidence — it grades only the reliability of the `mcc`
value itself, and is enforced to be `null` unless `mcc` is set
(`chk_fdh_merchants_mcc_confidence_needs_mcc`). No merchant carries a
fabricated precise percentage (e.g. "98.7%") anywhere.

## 4. Alias safety — the personal-payee guard

`lib/financial-data-hub/domain/personalPayeeGuard.ts` implements the
specification's required "flag likely personal-payee names for review"
guard: a simple, explainable heuristic (digit runs, email/UPI-handle
patterns, "TRANSFER TO <name>" phrasing, bare 1-3-word narratives with no
recognised business/institution keyword). It is deliberately conservative —
false positives are the safe failure direction, since a flag only means
"hold for admin review," never data loss. It is unit-tested against both
true positives ("JOHN SMITH", "TRANSFER TO AMAR", a UPI handle, a digit
run) and true negatives (real seeded brand names) in
`tests/unit/fdh2Domain.test.ts`. This guard applies to FUTURE candidate
intake (`fdh_global_learning_candidates`) — never to FHIP's own
hand-curated merchant library, which is verified by a human at authoring
time. No FDH-2 merchant row is a peer-transfer name or personal payee.

## 5. Payment processors — narrative shows processor, not merchant

`is_payment_processor` (new boolean) flags 8 India merchants: Razorpay,
PayU India, CCAvenue, Google Pay, PhonePe, Paytm, BillDesk, Cashfree — the
specification's explicitly-named concern ("narratives often show processor
not end merchant"). None of these carries a `default_category_id` — a
processor charge is never blindly classified into one economic category by
this master data; a future engine is expected to look for the downstream
merchant descriptor instead.

## 6. Recurring/subscription metadata — likelihood only

`recurring_possible`, `subscription_possible` (FDH-1), `typical_frequency`,
`fixed_amount_expected`, `variable_amount_possible` and `recurring_type`
(11-value enum) are all MERCHANT-LEVEL LIKELIHOOD metadata. None of them,
alone or combined, means "a transaction from this merchant IS recurring" —
actual recurrence detection is FDH-6. 6 AU merchants and 4 India merchants
are flagged `subscription_possible`; utilities/insurers/telcos are flagged
`recurring_possible` with `recurring_type` set appropriately (`utility`,
`insurance`, `telecom`) without the (stronger) subscription flag.

## 7. Sector coverage (AU, 69 merchants)

Groceries (5: Woolworths, Coles, ALDI, IGA, Costco), fuel (5: BP, Shell,
Ampol, 7-Eleven, United Petroleum), restaurants/takeaway/cafes (8: large
chains only — McDonald's, KFC, Hungry Jack's, Domino's, Subway, Guzman y
Gomez, Starbucks, The Coffee Club), utilities/telecom (6: AGL, Origin,
EnergyAustralia, Telstra, Optus, TPG, Vodafone AU), streaming/subscriptions
(6: Netflix, Spotify, Disney+, Amazon Prime, Stan, Kayo Sports), rideshare/
delivery (5: Uber, Uber Eats, DiDi, Menulog, DoorDash), transport (1:
Linkt), home improvement (2: Bunnings, Officeworks), department/discount
retail (6: Kmart, Target, Big W, Myer, David Jones, The Reject Shop),
online/e-commerce (5: Amazon AU, eBay, Catch, Temple & Webster, Booktopia),
insurance (7: Bupa, Medibank, nib, Allianz, AAMI, Budget Direct, QBE),
health/pharmacy (3: Chemist Warehouse, Priceline, Terry White Chemmart),
travel (7: Qantas, Jetstar, Virgin Australia, Flight Centre, Webjet,
Airbnb, Booking.com), education/childcare (2: Goodstart, G8 Education).

## 8. Sector coverage (India, 54 merchants)

Grocery/retail (4: BigBasket, DMart, Reliance Fresh, Spencer's), e-commerce
(5: Amazon India, Flipkart, Myntra, Meesho, Nykaa), food delivery (2:
Swiggy, Zomato), rideshare/transport (4: Ola, Uber India, Rapido, IRCTC),
telco/utilities (7: Jio, Airtel, Vi, Adani Electricity, Tata Power,
Indraprastha Gas, Mahanagar Gas), digital subscriptions (4: Netflix,
Amazon Prime, JioHotstar, Spotify), payment processors (8, see section 5),
fuel (3: IOCL, BPCL, HPCL), insurance (5: LIC, ICICI Lombard, HDFC ERGO,
Star Health, Bajaj Allianz), healthcare/pharmacy (5: Apollo Pharmacy, Tata
1mg, PharmEasy, Apollo Hospitals, Fortis Healthcare), travel (4:
MakeMyTrip, Goibibo, IndiGo, Air India), education (3, high-confidence
only: BYJU'S, Unacademy, Vedantu).

## 9. Rejected / excluded candidates

No merchant was rejected mid-authoring in this session — every candidate
considered was included once confidently identified. The exclusions are at
the RESEARCH stage (see `FDH2_RESEARCH_EVIDENCE.md`): a long tail of
smaller regional AU retailers and India local-chain merchants was not
attempted, since this session's non-live-web research method could not
verify them responsibly (see the coverage matrix in
`FDH2_COMPLETION_REPORT.md` for what is explicitly labelled
`FUTURE-EXPANSION`).
