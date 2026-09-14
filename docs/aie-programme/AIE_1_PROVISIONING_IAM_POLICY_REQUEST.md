# AIE-1 — Exact IAM Policy Requested for AWS Provisioning

Per the Product Owner's decision to grant scoped permissions and accept the
GuardDuty cost. This is the **provisioning-time** policy — the permissions
needed to CREATE the resources in `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md`.
It is separate from, and broader than, that runbook's own 5 narrow
**runtime** roles (`aie-upload-signer-dev` etc.), which this policy's own
`iam:CreateRole`/`iam:PutRolePolicy` statements create — this session never
needs to assume those runtime roles itself.

**Confirmed via live probe before requesting this**: the AWS identity
currently available to this session (`arn:aws:iam::879807128139:user/Amar`)
has zero relevant permissions today, and GuardDuty itself returns
`SubscriptionRequiredException` — it has never been enabled on this account.
Attach the policy below to that same user (or a new dedicated one) via the
IAM console: **Users → Amar → Add permissions → Create inline policy → JSON**.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AieS3BucketProvisioning",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketPolicy",
        "s3:PutBucketTagging",
        "s3:PutBucketOwnershipControls",
        "s3:PutPublicAccessBlock",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:PutBucketNotification",
        "s3:GetBucketNotification"
      ],
      "Resource": "arn:aws:s3:::fhip-aie-quarantine-dev"
    },
    {
      "Sid": "AieIamRoleProvisioning",
      "Effect": "Allow",
      "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:GetRole", "iam:TagRole"],
      "Resource": "arn:aws:iam::879807128139:role/aie-*"
    },
    {
      "Sid": "AieGuardDutyServiceLinkedRole",
      "Effect": "Allow",
      "Action": "iam:CreateServiceLinkedRole",
      "Resource": "arn:aws:iam::879807128139:role/aws-service-role/malware-protection.guardduty.amazonaws.com/*",
      "Condition": { "StringEquals": { "iam:AWSServiceName": "malware-protection.guardduty.amazonaws.com" } }
    },
    {
      "Sid": "AieGuardDuty",
      "Effect": "Allow",
      "Action": [
        "guardduty:CreateDetector",
        "guardduty:ListDetectors",
        "guardduty:GetDetector",
        "guardduty:CreateMalwareProtectionPlan",
        "guardduty:GetMalwareProtectionPlan",
        "guardduty:UpdateMalwareProtectionPlan"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AieEventBridge",
      "Effect": "Allow",
      "Action": ["events:PutRule", "events:PutTargets", "events:DescribeRule", "events:ListTargetsByRule"],
      "Resource": "arn:aws:events:ap-southeast-2:879807128139:rule/aie-*"
    },
    {
      "Sid": "AieSqs",
      "Effect": "Allow",
      "Action": ["sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:TagQueue"],
      "Resource": "arn:aws:sqs:ap-southeast-2:879807128139:aie-*"
    },
    {
      "Sid": "AieMonitoring",
      "Effect": "Allow",
      "Action": ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms"],
      "Resource": "arn:aws:cloudwatch:ap-southeast-2:879807128139:alarm:aie-*"
    },
    {
      "Sid": "AieBudgetAndSns",
      "Effect": "Allow",
      "Action": ["budgets:ViewBudget", "budgets:ModifyBudget", "sns:CreateTopic", "sns:Subscribe", "sns:SetTopicAttributes", "sns:TagResource"],
      "Resource": "*"
    }
  ]
}
```

**Why `Resource: "*"` on 2 statements, not narrower**: GuardDuty's
provisioning actions (`CreateDetector`, `CreateMalwareProtectionPlan`, etc.)
and AWS Budgets do not support resource-level ARN scoping for these specific
actions as of AWS's current IAM policy reference for either service — this
is a real API limitation, not a choice to grant broader access than
necessary. Every other statement is scoped to an `aie-`-prefixed resource
name or the one specific bucket.

**Not requested**: no `s3:*`, no `iam:*`, no `"Resource": "*"` on any S3 or
IAM action, no permission to touch Amplify, CloudFront, or any resource
outside the `aie-`/`fhip-aie-quarantine-dev` naming pattern used exclusively
by this feature.

**Once attached**, tell this session and it will:
1. Confirm the new permissions took effect via a benign read (`aws guardduty list-detectors`, `aws iam get-role --role-name aie-upload-signer-dev` returning `NoSuchEntity` rather than `AccessDenied`) — before creating anything.
2. Run the exact commands in `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` §2-6 in order, checking each step's actual result (not assuming success from HTTP 200 alone — e.g. explicitly verifying the GuardDuty plan reaches `ACTIVE` status, per that doc's own instruction).
3. Report back with the real, created resource ARNs/IDs and their confirmed status before wiring `lib/aie/malware/scanResultHandler.ts` into a real consumer route.
