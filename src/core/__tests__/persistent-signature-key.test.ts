import { describe, expect, it } from "vitest";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { validateKeyPackageAccountIdentityProof } from "../components/account-identity-proof.js";

const suite = () =>
  getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
const account = testAccount(5);

describe("persisted signature keys", () => {
  it("reuses the signing key with fresh init keys and valid 0x8009 proofs", async () => {
    const ciphersuiteImpl = await suite();
    const signatureKeyPair = await ciphersuiteImpl.signature.keygen();
    const options = {
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl,
      signatureKeyPair,
    };
    const first = await generateKeyPackage(options);
    const second = await generateKeyPackage(options);
    for (const kp of [first, second]) {
      expect(kp.publicPackage.leafNode.signaturePublicKey).toEqual(
        signatureKeyPair.publicKey,
      );
      expect(() =>
        validateKeyPackageAccountIdentityProof(kp.publicPackage),
      ).not.toThrow();
    }
    expect(first.publicPackage.initKey).not.toEqual(
      second.publicPackage.initKey,
    );
    expect(first.publicPackage.leafNode.hpkePublicKey).not.toEqual(
      second.publicPackage.leafNode.hpkePublicKey,
    );
    const wrong = await ciphersuiteImpl.signature.keygen();
    expect(() =>
      validateKeyPackageAccountIdentityProof({
        ...first.publicPackage,
        leafNode: {
          ...first.publicPackage.leafNode,
          signaturePublicKey: wrong.publicKey,
        },
      }),
    ).toThrow();
  });

  it("generates fresh signing keys by default", async () => {
    const ciphersuiteImpl = await suite();
    const options = {
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl,
    };
    const first = await generateKeyPackage(options);
    const second = await generateKeyPackage(options);
    expect(first.publicPackage.leafNode.signaturePublicKey).not.toEqual(
      second.publicPackage.leafNode.signaturePublicKey,
    );
  });

  it("rejects mismatched and incompatible key pairs without exposing them", async () => {
    const ciphersuiteImpl = await suite();
    const first = await ciphersuiteImpl.signature.keygen();
    const second = await ciphersuiteImpl.signature.keygen();
    const options = {
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl,
    };
    await expect(
      generateKeyPackage({
        ...options,
        signatureKeyPair: {
          publicKey: second.publicKey,
          signKey: first.signKey,
        },
      }),
    ).rejects.toThrow("signatureKeyPair is incompatible");
    const other = await getCiphersuiteImpl(
      "MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448",
      defaultCryptoProvider,
    );
    await expect(
      generateKeyPackage({
        ...options,
        signatureKeyPair: await other.signature.keygen(),
      }),
    ).rejects.toThrow("signatureKeyPair is incompatible");
  });
});
