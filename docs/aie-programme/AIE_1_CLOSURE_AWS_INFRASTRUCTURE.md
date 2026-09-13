# AIE-1 Closure — AWS Temporary Quarantine Infrastructure (DEV)

**Status: NOT PROVISIONED. Documentation and exact commands only.**
No AWS credentials exist anywhere in this environment (confirmed by this
mission's own environment check before any work began: `grep -oE
"^[A-Z_]+" .env.local | grep -iE "AWS|OPENAI|S3|GUARDDUTY"` returns nothing).
This document cannot be executed by this closure mission — it is the
reviewable, ready-to-run specification a human operator with real AWS
console/CLI access uses to provision AIE-1's DEV quarantine infrastructure.

**Why a runbook, not Terraform/CDK/CloudFormation.** This repository has no
IaC tooling anywhere (confirmed: no `terraform/`, `cdk/`, `.aws/`, or
CloudFormation template in the repo; deployment is AWS Amplify via
`amplify.yml`, and every existing infra change in this project's history —
Supabase Storage buckets, `pg_cron` jobs — was done via narrative runbook +
exact CLI/SQL commands, e.g. `supabase/migrations/0135_...sql`'s own
operator-action-required sections). Introducing a brand-new IaC framework
un-exercisable by this mission (no credentials to test it against) would add
risk without adding real capability. Every command below is copy-paste
runnable by an operator with an AWS CLI profile configured for the target
account.

**Region**: `ap-southeast-2` (Sydney) — matches this app's primary AU/India
household base and Supabase DEV project's own general locality; substitute
your organisation's approved region if different. Every ARN/command below
uses `ap-southeast-2` as a placeholder — replace consistently.

**Account placeholder**: `<AWS_ACCOUNT_ID>` throughout.

---

## 1. Object identity & versioning decision (mission section 5.2)

**Decision: Option B — unique immutable upload objects, overwrite
prevention enforced at PUT time. Versioning is NOT enabled.**

Rationale: Option A (versioning) requires handling noncurrent-version
cleanup and delete markers as a whole additional lifecycle dimension (the
mission's own warning: "do not enable versioning without handling
noncurrent versions and delete markers"). AIE's quarantine objects are
already random-UUID-keyed (`{userId}/{intakeId}/{intakeId}.bin`, from
`lib/aie/storage.ts`) and never intentionally overwritten — a genuinely new
document always gets a genuinely new `intakeId`, hence a genuinely new key.
Versioning would only ever protect against an ACCIDENTAL overwrite of the
exact same key, which Option B prevents structurally instead: every PUT
uses a conditional-write header (`If-None-Match: *`, supported by S3 as of
the 2022 conditional-writes feature) so a second PUT to the same key is
rejected by S3 itself, not merely discouraged by convention.

**Binding to exact bytes** (mission section 5.2: "every clean scan decision
must bind to the exact bytes subsequently read"): with overwrite prevention
guaranteed at the S3 API level, `(bucket, key)` alone is already sufficient
to identify one immutable set of bytes — but `lib/aie/malware/
scanResultHandler.ts`'s `decideScanResult()` STILL independently checks
both `versionId` and `eTag` against the expected pending job (defense in
depth — see that file's own header), so a bucket later reconfigured to
enable versioning, or a policy misconfiguration that permits an overwrite
despite the conditional-write header, does not silently regress this
guarantee into "read whatever object currently sits at this key."

---

## 2. S3 bucket

```bash
BUCKET=aie-document-quarantine-dev
REGION=ap-southeast-2
ACCOUNT_ID=<AWS_ACCOUNT_ID>

aws s3api create-bucket \
  --bucket "$BUCKET" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"

# Block Public Access -- ALL FOUR settings, unconditionally.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Bucket-owner-enforced ownership (ACLs disabled entirely).
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls \
  Rules='[{ObjectOwnership=BucketOwnerEnforced}]'

# Encryption at rest -- SSE-S3 (mission section 5.1: "select SSE-S3 unless
# an existing requirement mandates SSE-KMS" -- no such existing requirement
# was found anywhere in this repo's other document buckets, which also use
# SSE-S3/default Supabase encryption, not customer-managed KMS keys).
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

# HTTPS-only + deny non-owner-enforced ACL writes (bucket policy).
cat > /tmp/aie-bucket-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::$BUCKET", "arn:aws:s3:::$BUCKET/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
POLICY
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/aie-bucket-policy.json

# Abandoned multipart-upload cleanup + explicit lifecycle backstop (mission
# section 5.1/4.2: 24h maximum temporary binary age). NoncurrentVersion
# rules are omitted deliberately -- versioning is not enabled (section 1).
cat > /tmp/aie-lifecycle.json <<LIFECYCLE
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    },
    {
      "ID": "hard-backstop-24h-expiry",
      "Status": "Enabled",
      "Filter": {},
      "Expiration": { "Days": 1 }
    }
  ]
}
LIFECYCLE
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration file:///tmp/aie-lifecycle.json

# CORS -- restricted to this app's actual DEV/production origins only.
cat > /tmp/aie-cors.json <<CORS
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.financialhealthplatform.com"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 300
    }
  ]
}
CORS
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file:///tmp/aie-cors.json
```

Note on the S3 Lifecycle "Days: 1" expiration: S3 Lifecycle evaluates once
per day, not continuously — mission section 4.2/4.3's own instruction
applies here verbatim: **"Do not claim an exact deletion deadline if the
infrastructure only provides eventual lifecycle expiry."** The APPLICATION's
own purge job (`lib/aie/services/purge.ts`, immediate deletion + the 15-
minute sweep) is the real, bounded enforcement of the 24-hour maximum — this
S3 Lifecycle rule is a true backstop-of-the-backstop only, for the case
where the application itself never runs again for over a day.

Random object keys already avoid personal identifiers structurally: `lib/
aie/storage.ts#buildQuarantineStorageKey` uses `{userId}/{intakeId}/
{intakeId}.bin` — both are random UUIDs, never an email/name/document
number.

---

## 3. GuardDuty Malware Protection for S3

```bash
# One-time: enable GuardDuty in this account/region if not already active.
aws guardduty create-detector --enable --region "$REGION"
DETECTOR_ID=$(aws guardduty list-detectors --region "$REGION" --query 'DetectorIds[0]' --output text)

# GuardDuty's own service-linked role for Malware Protection for S3 (NOT
# GuardDuty's general S3 Protection feature -- mission section 6 is explicit
# these are different features; this creates the role
# AWSServiceRoleForAmazonGuardDutyMalwareProtection, which GuardDuty itself
# assumes to read/tag objects in the protected bucket -- least privilege is
# AWS-managed here, not something this runbook writes by hand).
aws iam create-service-linked-role --aws-service-name malware-protection.guardduty.amazonaws.com || true

# Create the Malware Protection plan for the quarantine bucket.
aws guardduty create-malware-protection-plan \
  --region "$REGION" \
  --role "arn:aws:iam::$ACCOUNT_ID:role/service-role/AmazonGuardDutyMalwareProtectionRole" \
  --protected-resource "S3Bucket={BucketName=$BUCKET}"

# Verify the plan is genuinely ACTIVE before relying on it (mission section
# 6: "verify the plan is active" -- do not assume success from the create
# call's HTTP 200 alone).
aws guardduty get-malware-protection-plan --region "$REGION" \
  --malware-protection-plan-id <PLAN_ID_FROM_CREATE_RESPONSE>
# Expect: "status": "ACTIVE". If "WARNING"/"ERROR", see AWS's own
# troubleshooting doc (statusReasons codes like
# INSUFFICIENT_TEST_OBJECT_PERMISSIONS/EVENTBRIDGE_MANAGED_EVENTS_DELIVERY_DISABLED)
# before proceeding -- these surface as EventBridge "GuardDuty Malware
# Protection Resource Status Warning/Error" events too (see
# lib/aie/malware/scanResultTypes.ts's header for the verified event shapes;
# this doc's scope is the Object Scan Result event specifically).
```

The IAM role GuardDuty attaches to the protected bucket needs (per AWS's own
policy template) `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObjectTagging`
scoped to `arn:aws:s3:::$BUCKET/*` — this is the ONE role permitted access to
UNSCANNED objects (mission section 6.3: "preserve GuardDuty access to
unscanned objects"). No other role in section 6 below is granted this.

---

## 4. EventBridge rule → SQS → DLQ

```bash
QUEUE=aie-guardduty-scan-result-dev
DLQ=aie-guardduty-scan-result-dlq-dev

# DLQ first (queue creation order: DLQ must exist before the main queue
# references its ARN in redrive policy).
DLQ_URL=$(aws sqs create-queue --queue-name "$DLQ" --region "$REGION" --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --region "$REGION" --query 'Attributes.QueueArn' --output text)

QUEUE_URL=$(aws sqs create-queue --queue-name "$QUEUE" --region "$REGION" \
  --attributes '{
    "RedrivePolicy": "{\"deadLetterTargetArn\":\"'"$DLQ_ARN"'\",\"maxReceiveCount\":\"5\"}",
    "VisibilityTimeout": "120",
    "MessageRetentionPeriod": "1209600"
  }' --query QueueUrl --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --region "$REGION" --query 'Attributes.QueueArn' --output text)

# Allow EventBridge to deliver to this queue.
cat > /tmp/aie-sqs-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowEventBridge",
    "Effect": "Allow",
    "Principal": { "Service": "events.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "$QUEUE_ARN",
    "Condition": { "ArnEquals": { "aws:SourceArn": "arn:aws:events:$REGION:$ACCOUNT_ID:rule/aie-guardduty-scan-result-rule" } }
  }]
}
POLICY
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes Policy="$(cat /tmp/aie-sqs-policy.json)"

# EventBridge rule -- matches ONLY the "Object Scan Result" detail-type
# (mission section 6.2: "use the documented EventBridge scan-result event"),
# scoped to this one protected bucket via the event pattern's
# detail.s3ObjectDetails.bucketName so unrelated buckets' scan results never
# reach this queue even if GuardDuty later protects more than one bucket.
cat > /tmp/aie-event-pattern.json <<PATTERN
{
  "source": ["aws.guardduty"],
  "detail-type": ["GuardDuty Malware Protection Object Scan Result"],
  "detail": { "s3ObjectDetails": { "bucketName": ["$BUCKET"] } }
}
PATTERN
aws events put-rule --name aie-guardduty-scan-result-rule --region "$REGION" \
  --event-pattern file:///tmp/aie-event-pattern.json --state ENABLED

aws events put-targets --rule aie-guardduty-scan-result-rule --region "$REGION" \
  --targets "Id"="1","Arn"="$QUEUE_ARN"
```

**Consumer (not deployed by this mission)**: `lib/aie/malware/
scanResultHandler.ts#decideScanResult()` is the reviewed, unit-tested
decision logic a real SQS consumer (a scheduled poller hitting a new `app/
api/aie/malware/scan-result-consumer/route.ts`, or a Lambda triggered
directly by the queue) would call per message. **Never acknowledge/delete
the SQS message until the decision's implied durable DB transition has
itself succeeded** (mission section 6.2) — a message deleted before the
transition commits is unrecoverable if the process then crashes; redelivery
after `VisibilityTimeout` (120s here) is the correct, safe default, and
`decideScanResult`'s own duplicate-detection input handles the resulting
redelivery idempotently.

---

## 5. IAM — least privilege, one role per concern (mission section 5.4)

Five separate roles/policies, none overlapping, none broader than the
concern it serves:

| Role | Permitted actions | Resource scope |
|---|---|---|
| `aie-upload-signer-dev` | `s3:PutObject` only (for generating a presigned PUT URL server-side) | `arn:aws:s3:::$BUCKET/*` |
| GuardDuty's own service role (section 3) | `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObjectTagging` | `arn:aws:s3:::$BUCKET/*` |
| `aie-extraction-reader-dev` | `s3:GetObject` — additionally CONDITIONED on the object's GuardDuty scan-result tag equalling `NO_THREATS_FOUND` (section 6.3 below) | `arn:aws:s3:::$BUCKET/*` |
| `aie-scan-result-consumer-dev` | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on the queue; no S3 permission at all — it only reads events and writes to Supabase, never touches the S3 object directly | `arn:aws:sqs:...:aie-guardduty-scan-result-dev` |
| `aie-cleanup-dev` | `s3:DeleteObject` only | `arn:aws:s3:::$BUCKET/*` |

None of these five roles is granted `s3:PutObjectTagging` — **uploaders
must not be able to assign or modify the trusted scan-result tag**
(mission section 5.4/6.3). Only GuardDuty's own service role can write that
tag.

```bash
# aie-upload-signer-dev
cat > /tmp/aie-upload-signer-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::$BUCKET/*" }]
}
POLICY
aws iam create-role --role-name aie-upload-signer-dev --assume-role-policy-document file://<your-app-trust-policy>.json
aws iam put-role-policy --role-name aie-upload-signer-dev --policy-name aie-upload-signer-policy --policy-document file:///tmp/aie-upload-signer-policy.json

# aie-extraction-reader-dev -- tag-conditioned read (section 6.3).
cat > /tmp/aie-extraction-reader-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET/*",
    "Condition": { "StringEquals": { "s3:ExistingObjectTag/GuardDutyMalwareScanStatus": "NO_THREATS_FOUND" } }
  }]
}
POLICY
aws iam create-role --role-name aie-extraction-reader-dev --assume-role-policy-document file://<your-app-trust-policy>.json
aws iam put-role-policy --role-name aie-extraction-reader-dev --policy-name aie-extraction-reader-policy --policy-document file:///tmp/aie-extraction-reader-policy.json

# aie-scan-result-consumer-dev
cat > /tmp/aie-consumer-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
    "Resource": "$QUEUE_ARN"
  }]
}
POLICY
aws iam create-role --role-name aie-scan-result-consumer-dev --assume-role-policy-document file://<your-app-trust-policy>.json
aws iam put-role-policy --role-name aie-scan-result-consumer-dev --policy-name aie-consumer-policy --policy-document file:///tmp/aie-consumer-policy.json

# aie-cleanup-dev
cat > /tmp/aie-cleanup-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "s3:DeleteObject", "Resource": "arn:aws:s3:::$BUCKET/*" }]
}
POLICY
aws iam create-role --role-name aie-cleanup-dev --assume-role-policy-document file://<your-app-trust-policy>.json
aws iam put-role-policy --role-name aie-cleanup-dev --policy-name aie-cleanup-policy --policy-document file:///tmp/aie-cleanup-policy.json
```

**Tag-based access control caveat, verified against AWS's own guidance**:
the `s3:ExistingObjectTag/<key>` condition key only works for object tags
GuardDuty itself has actually written by the time the read is attempted —
this is exactly why `lib/aie/malware/scanResultHandler.ts` ALSO enforces the
clean-state check independently in application logic (mission section 6.3:
"also enforce clean state in AIE. Neither layer replaces the other") —
relying on the IAM condition alone would fail open on any tagging delay or
failure (see the "post-scan tag failure event" case documented in
`scanResultTypes.ts`'s header sources), whereas the DB-driven application
check has no such race.

**No application component receives broad administrator permissions** —
confirmed by construction above: every role's policy is a single-action or
narrow-multi-action statement scoped to one resource ARN pattern, never
`"Action": "s3:*"` or `"Resource": "*"`.

---

## 6. Monitoring and cost alerts (mission section 5/13)

```bash
# CloudWatch alarm: DLQ depth > 0 for 5 minutes -- a scan-result message
# that failed 5 delivery attempts needs human attention (mission section
# 6.2: "configure dead-letter handling and alerts").
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name aie-scan-result-dlq-not-empty \
  --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value="$DLQ" \
  --statistic Maximum --period 300 --evaluation-periods 1 \
  --threshold 0 --comparison-operator GreaterThanThreshold \
  --alarm-actions <SNS_TOPIC_ARN_FOR_ALERTS>

# AWS Budgets: a small monthly ceiling on this bucket/GuardDuty's own spend
# (separate from AIE's own $10 OpenAI pilot allowance -- lib/aie/config.ts
# -- this is the AWS-side cost, not the AI-provider-side cost). Mission
# section 8: "do not rely solely on provider dashboard budgets as hard
# stops" applies to the AI cost, which this mission already enforces via a
# real atomic DB reservation (migration 0148) -- this budget alert is a
# secondary, AWS-side observability signal, not AIE's primary cost gate.
aws budgets create-budget --account-id "$ACCOUNT_ID" --budget '{
  "BudgetName": "aie-guardduty-s3-quarantine-dev",
  "BudgetLimit": { "Amount": "25", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST",
  "CostFilters": { "TagKeyValue": ["user:Project$AIE-1"] }
}' --notifications-with-subscribers '[{
  "Notification": {"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},
  "Subscribers": [{"SubscriptionType":"EMAIL","Address":"<ops-alert-email>"}]
}]'
```

Tag every resource created above with `Project=AIE-1` for the budget filter
to work (`aws s3api put-bucket-tagging` / `aws sqs tag-queue` / etc.) —
omitted from the individual commands above for brevity; add
`--tagging 'TagSet=[{Key=Project,Value=AIE-1}]'`-equivalent calls per
resource before relying on this budget filter.

---

## 7. Storage topology (mission section 5.3)

**Current state (confirmed by direct inspection of `lib/aie/storage.ts`,
all three intake routes, and `app/api/aie/insurance/intake/route.ts` etc.)**:
every AIE upload today goes through the existing server-mediated pattern —
the browser POSTs the raw file bytes to a Next.js API route, which then
writes to Supabase Storage via `uploadToQuarantine()`. No direct-to-S3
signed-upload path exists yet anywhere in this codebase.

**Recommended target (not built this pass, scoped and documented here for
the next phase)**: mission section 5.3's "prefer direct browser upload to
S3 through a server-issued signed request" — a new route
(`app/api/aie/upload-url/route.ts`, illustrative name) using
`aie-upload-signer-dev`'s role to generate a presigned S3 PUT URL scoped to
one random key, returned to the browser, which uploads directly (bypassing
the app server for the (potentially large) file bytes themselves — Supabase
auth/session/RLS-scoped ownership record creation still happens server-side
first, exactly as today, just without the raw bytes round-tripping through
the Node process).

**Why this migration was NOT attempted in this closure mission**: it
requires an actual reachable S3 bucket to test a presigned-URL flow against
(cannot be verified with zero AWS credentials — the exact same blocker as
GuardDuty itself), and doing so without the ability to verify the SigV4
signing code against real S3 was judged higher-risk than valuable
(shipping untested request-signing code is exactly the kind of "fabricated
verification" mission section 17 explicitly forbids: "never fabricate...
provider calls"). `lib/aie/storage.ts` remains the sole quarantine storage
module — no double-storage across clouds was introduced, and no historical
document was migrated (mission section 5.3's own "avoid routine double
storage" / "do not migrate historical documents unnecessarily" are both
satisfied by simply not touching storage topology at all this pass).

**Region/network/transfer implications for the future migration**: Supabase
DEV project host `vqycarelcoijzwlpkpcz.supabase.co` and the S3 bucket above
are in different clouds entirely — the presigned-upload browser flow avoids
any AWS<->Supabase server-side data egress for the upload itself (the
browser talks to S3 directly), but the ACCEPT-time canonical write path
(`lib/aie/review/accept.ts`, for Investment Intelligence and FDH-bank —
see this mission's own `finalizeDocumentBinary` change) downloads the
object server-side to hand to FDH-5/II's own write services, which would
then be a genuine cross-cloud egress (AWS ap-southeast-2 -> wherever the
Node runtime executing that route is deployed, likely also
ap-southeast-2/AWS Amplify's own region) — small (single-document) and
infrequent (once per accepted document), not a volume concern, but real and
worth the same region alignment discipline used above.
