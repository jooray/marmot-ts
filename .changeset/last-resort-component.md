---
"@internet-privacy/marmot-ts": patch
---

Mark last-resort KeyPackages with the empty `last_resort_key_package` component (`0x0004`) in a
KeyPackage-level `app_data_dictionary`, as the spec requires and as MDK / White Noise (OpenMLS
`mark_as_last_resort`) emit, instead of the legacy `last_resort` extension (`0x000a`). The legacy
extension type is no longer advertised in LeafNode capabilities or the `mls_extensions` tag. Adds
`isLastResortKeyPackage` (recognizes both encodings) and `LAST_RESORT_KEY_PACKAGE_COMPONENT_ID`.
