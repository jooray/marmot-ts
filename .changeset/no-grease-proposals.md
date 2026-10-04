---
"@internet-privacy/marmot-ts": patch
---

Stop advertising GREASE proposal types in KeyPackage capabilities. The kind-30443 `mls_proposals`
tag omits GREASE, and MDK requires that tag to equal the decoded proposal capabilities exactly, so
MDK/White Noise rejected most marmot-ts KeyPackages ("mls_proposals tag does not exactly match
decoded KeyPackage metadata") and could not invite marmot-ts users. GREASE is kept in the other
capability lists.
