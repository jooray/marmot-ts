import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../credential.js";
import { isGreaseValue } from "../grease.js";
import { generateKeyPackage } from "../key-package.js";
import { createKeyPackageEvent } from "../key-package-event.js";

const hex = (id: number) => `0x${id.toString(16).padStart(4, "0")}`;
const tagValues = (tags: string[][], name: string) =>
  new Set(tags.find((t) => t[0] === name)!.slice(1));

/**
 * MDK's acceptance rule for a kind-30443 event
 * (`marmot-app/src/key_package_records.rs`, `require_multi_value_key_package_tag_matches`):
 * the `mls_proposals` tag must equal the decoded LeafNode proposal capabilities
 * exactly, while `mls_extensions` is compared after dropping GREASE
 * (`cgka-engine/src/capabilities.rs`, `advertised_capabilities_from_caps`).
 */
describe("KeyPackage GREASE vs MDK tag/metadata parity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the mls_proposals tag equal to the decoded proposals even when ts-mls GREASEs every list", async () => {
    // ts-mls adds each GREASE value with probability 0.1 via Math.random();
    // forcing 0 makes it add all of them to every capability list.
    vi.spyOn(Math, "random").mockReturnValue(0);

    const account = testAccount(3);
    const keyPackage = await generateKeyPackage({
      credential: createCredential(account.pubkey),
      ciphersuiteImpl: await getCiphersuiteImpl(
        "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
        defaultCryptoProvider,
      ),
      signer: account.signer,
    });
    const event = await createKeyPackageEvent({
      keyPackage: keyPackage.publicPackage,
      identifier: "a1".repeat(32),
    });
    const caps = keyPackage.publicPackage.leafNode.capabilities;

    expect(tagValues(event.tags, "mls_proposals")).toEqual(
      new Set(caps.proposals.map(hex)),
    );
    expect(tagValues(event.tags, "mls_extensions")).toEqual(
      new Set(caps.extensions.filter((e) => !isGreaseValue(e)).map(hex)),
    );

    // GREASE is still exercised where MDK tolerates it.
    expect(caps.extensions.some(isGreaseValue)).toBe(true);
    expect(caps.proposals.some(isGreaseValue)).toBe(false);
  });
});
