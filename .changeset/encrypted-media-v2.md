---
"@internet-privacy/marmot-ts": minor
---

Add Marmot encrypted media v2: the `marmot.group.encrypted-media.v2` app component
(`0x800b`) and the `encrypted-media-v2` message format, wire-compatible with MDK.

- KeyPackages now advertise `0x800b` (next to the frozen `0x8008`), so White Noise / MDK
  users can invite marmot-ts users into their groups, which require `0x800b`.
- New groups created with `createSimpleGroup` / `groups.create` carry and require a
  `0x800b` policy over MDK's default Blossom endpoints. Pass `encryptedMedia: false` to
  create a group without media, or a policy to choose the endpoints.
- `0x800b` codec (`encodeEncryptedMediaPolicyV2`, `decodeEncryptedMediaPolicyV2`,
  `encryptedMediaV2BlossomDefault`, `getEncryptedMediaPolicyV2`, `encryptedMediaV2Entry`),
  AppDataUpdate payload validation, and `MarmotGroupView.encryptedMediaV2`.
- `encrypted-media-v2` references: `parseMediaAttachment` (typed rejections matching MDK's
  categories), `getMediaAttachmentOutcomes` (attachment-local rejection), v2 key
  derivation and AAD, the strict v2 media-type profile (`canonicalizeMimeTypeV2`) and
  filename profile. v1 references still parse and decrypt.
- `GroupMediaService` / `MarmotGroup` pick the media format from the group
  (`encrypted-media-v2` unless the group only carries `0x8008`) and gain `uploadMedia` /
  `downloadMedia` with minimal Blossom helpers (`uploadBlossomBlob`, `fetchBlossomBlob`).

Behaviour change: `encryptMedia` in a group without any encrypted-media component now
produces `encrypted-media-v2` references instead of v1, because every group this library
joins is a current-profile group.
