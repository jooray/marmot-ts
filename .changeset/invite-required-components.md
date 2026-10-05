---
"@internet-privacy/marmot-ts": patch
---

Refuse to invite (or found a group with) a KeyPackage whose leaf does not advertise every app
component the group requires, or a required agent-text-stream role. MDK members reject such an Add
commit, so the group forked: marmot-ts members moved to the next epoch and White Noise members did
not. `evaluateKeyPackageForGroup()` now reports missing app components too, and the check is
exported as `missingGroupRequirements()`.
