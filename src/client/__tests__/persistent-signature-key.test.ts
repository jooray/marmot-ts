import { expect, it } from "vitest";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { KeyPackagePublisher } from "../key-package-publisher.js";
import type { NostrNetworkInterface } from "../nostr-interface.js";

it("passes the persisted identity through publisher generation", async () => {
  const suite = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const pair = await suite.signature.keygen();
  const publisher = new KeyPackagePublisher({
    signer: testAccount(5).signer,
    network: {} as NostrNetworkInterface,
    getSignatureKeyPair: async (selected) => {
      expect(selected.id).toBe(suite.id);
      return pair;
    },
  });
  const first = await publisher.generate();
  const second = await publisher.generate();
  expect(first.publicPackage.leafNode.signaturePublicKey).toEqual(
    pair.publicKey,
  );
  expect(second.publicPackage.leafNode.signaturePublicKey).toEqual(
    pair.publicKey,
  );
  expect(first.publicPackage.initKey).not.toEqual(second.publicPackage.initKey);
});
