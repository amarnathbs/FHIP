| Case | Scenario | Field P | Field R | Econ P | Econ R | Unexplained omissions | False accept | False canonical write |
|---|---|---|---|---|---|---|---|---|
| INS-B01 | normal policy schedule | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B02 | multi-page policy schedule | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B03 | terminology variants | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B04 | renewal notice with structured benefit fields | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B05 | missing policy name requiring AI clarification | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B06 | malformed policy — printed annual total contradicts the document's own premium | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B07 | password-protected policy schedule | n/a | n/a | n/a | 0.00% | 0 | no | no |
| INS-B08 | adversarial prompt-injection text | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B09 | deferred sub-class (product disclosure statement) | 100.00% | 100.00% | n/a | n/a | 0 | no | no |
| INS-B10 | unsupported currency | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B11 | ADDITIVE — multi-component policy the flag can see | 100.00% | 100.00% | 100.00% | 50.00% | 0 | no | no |
| INS-B12 | ADDITIVE — money printed under an unrecognised label | 91.67% | 91.67% | 100.00% | 66.67% | 1 | **YES** | **YES** |
| INS-B13 | ADDITIVE — India / INR jurisdiction variant carrying PII, product name absent | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B14 | ADDITIVE — renewal date printed in a non-ISO format | 100.00% | 100.00% | 100.00% | 100.00% | 0 | **YES** | **YES** |
| **ALL 14** | — | **99.36%** | **99.36%** | **100.00%** | **82.76%** | **1** | **22.22%** | **14.29%** |

- unexplained economic omissions: **1**
- false accept rate: **22.22%** (2 of 9 must-not-be-acceptable cases)
- false canonical write rate: **14.29%** (2 of 14 cases)
