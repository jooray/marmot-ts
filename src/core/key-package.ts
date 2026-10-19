/** @module @category Core - Key Package */
import {
  Capabilities,
  Credential,
  CryptoProvider,
  CiphersuiteId,
  CiphersuiteImpl,
  defaultCredentialTypes,
  defaultCryptoProvider,
  CustomExtension,
  KeyPackage,
  generateKeyPackageWithKey as MLSGenerateKeyPackageWithKey,
  Lifetime,
  makeKeyPackageRef,
  PrivateKeyPackage,
  appDataDictionaryExtensionType,
  makeAppDataDictionaryExtension,
} from "ts-mls";
import { hexToBytes } from "@noble/hashes/utils.js";

import {
  createDefaultKeyPackageLifetime,
  isLifetimeWithinCap,
} from "../utils/timestamp.js";
import type { AuthorizationProofSigner } from "./authorization-proof.js";
import { ensureMarmotCapabilities } from "./capabilities.js";
import {
  makeLeafAppComponentsExtension,
  produceAccountIdentityProof,
} from "./components/index.js";
import { getCredentialPubkey } from "./credential.js";
import { defaultCapabilities } from "./default-capabilities.js";
import { LAST_RESORT_EXTENSION_TYPE } from "./protocol.js";
import { readKeyPackageDictionary } from "./key-package-dictionary.js";
import { appComponentsEntry } from "./components/dictionary.js";

/**
 * A complete key package containing both public and private components.
 *
 * The public package can be shared with others to add this participant to groups,
 * while the private package must be kept secret and is used for decryption and signing.
 */
export type CompleteKeyPackage = {
  /** The public key package that can be shared with others */
  publicPackage: KeyPackage;
  /** The private key package that must be kept secret */
  privatePackage: PrivateKeyPackage;
};

/** Create default extensions for a key package */
export function keyPackageDefaultExtensions(): CustomExtension[] {
  return [
    makeAppDataDictionaryExtension([
      appComponentsEntry([0x0004]),
      { componentId: 0x0004, data: new Uint8Array() },
    ]),
  ];
}

export { isReusableKeyPackage } from "./key-package-dictionary.js";

/** Calculates a key package reference with the hash implementation based on the key package's cipher suite */
export async function calculateKeyPackageRef(
  keyPackage: KeyPackage,
  cryptoProvider?: CryptoProvider,
): Promise<Uint8Array> {
  const provider = cryptoProvider ?? defaultCryptoProvider;
  const ciphersuiteImpl = await provider.getCiphersuiteImpl(
    keyPackage.cipherSuite as CiphersuiteId,
  );
  return await makeKeyPackageRef(keyPackage, ciphersuiteImpl.hash);
}

/** Signature key material returned by the selected ciphersuite. Keep signKey secret. */
export type SignatureKeyPair = Awaited<
  ReturnType<CiphersuiteImpl["signature"]["keygen"]>
>;

/** Options for generating a marmot key package */
export type GenerateKeyPackageOptions = {
  /** Reuse an installation signing identity; init and encryption keys remain fresh. */
  signatureKeyPair?: SignatureKeyPair;
  credential: Credential;
  capabilities?: Capabilities;
  lifetime?: Lifetime;
  extensions?: CustomExtension[];
  /**
   * Whether to mark this KeyPackage as reusable using the canonical empty-data
   * `last_resort_key_package` component in its KeyPackage dictionary.
   *
   * - `true`: include the component (reusable; helps with race windows)
   * - `false`: omit the component (single-use; private init_key is expected to be consumed)
   *
   * Default: `true` for backwards compatibility with existing marmot-ts behavior.
   */
  isLastResort?: boolean;
  /**
   * The Nostr account signer that proves this KeyPackage's leaf by signing the
   * kind-450 account identity proof through `signEvent`; its public key MUST
   * equal the credential identity. Any signEvent-capable signer works (a local
   * key signer, NIP-07, NIP-46).
   */
  signer: AuthorizationProofSigner;
  /**
   * Injected `created_at` (Unix seconds) for the account identity proof.
   * Defaults to the current time. Core-only: meant for byte-stable tests and
   * fixtures; the client layer does not expose this option.
   */
  createdAt?: number;
  ciphersuiteImpl: CiphersuiteImpl;
};

/**
 * Generates a Marmot KeyPackage carrying a `0x8009` account identity proof on
 * its LeafNode.
 *
 * @see refs/marmot/foundation/key-packages.md
 * @see refs/marmot/app-components/account-identity-proof-v2.md
 */
export async function generateKeyPackage({
  credential,
  capabilities,
  lifetime,
  extensions,
  isLastResort = true,
  signer,
  createdAt,
  signatureKeyPair: suppliedSignatureKeyPair,
  ciphersuiteImpl,
}: GenerateKeyPackageOptions): Promise<CompleteKeyPackage> {
  if (credential.credentialType !== defaultCredentialTypes.basic)
    throw new Error("Marmot key packages must use a basic credential");

  // Ensure the credential has a valid pubkey
  const accountPubkey = getCredentialPubkey(credential);

  const resolvedCapabilities = capabilities
    ? ensureMarmotCapabilities(capabilities)
    : defaultCapabilities();
  const resolvedLifetime = lifetime ?? createDefaultKeyPackageLifetime();
  // WIRE-01 produce path: the cap must hold regardless of how lifetime is
  // supplied. The default is always within cap, so this check only ever
  // rejects an explicit caller-supplied `lifetime` override (D-09).
  if (!isLifetimeWithinCap(resolvedLifetime))
    throw new Error(
      `generateKeyPackage: lifetime range ${resolvedLifetime.notAfter - resolvedLifetime.notBefore}s exceeds the 7,261,200s (84-day) cap`,
    );
  // Reuse is KeyPackage data, never an MLS capability or LeafNode entry
  // (refs/marmot/foundation/key-packages.md).
  const suppliedExtensions = extensions ?? [];
  const dictionary = (
    readKeyPackageDictionary(suppliedExtensions) ?? []
  ).filter(
    (entry) => entry.componentId !== 0x0004 && entry.componentId !== 0x0001,
  );
  if (isLastResort)
    dictionary.push({ componentId: 0x0004, data: new Uint8Array() });
  dictionary.sort((a, b) => a.componentId - b.componentId);
  const resolvedExtensions = suppliedExtensions.filter(
    (extension) =>
      extension.extensionType !== LAST_RESORT_EXTENSION_TYPE &&
      extension.extensionType !== appDataDictionaryExtensionType,
  );
  if (dictionary.length)
    resolvedExtensions.push(
      makeAppDataDictionaryExtension([
        appComponentsEntry(dictionary.map((entry) => entry.componentId)),
        ...dictionary,
      ]),
    );

  // Every leaf carries exactly one 0x8009 account identity proof binding the
  // leaf signature key to the Nostr account (refs/marmot/app-components/
  // account-identity-proof-v2.md; refs/marmot/foundation/key-packages.md).
  // The leaf signature keypair is selected first so the proof can bind it.
  const signatureKeyPair =
    suppliedSignatureKeyPair ?? (await ciphersuiteImpl.signature.keygen());
  if (suppliedSignatureKeyPair) {
    // A sign/verify round trip validates both the algorithm and matching halves.
    // Do not expose key material or provider errors in the failure message.
    const challenge = new TextEncoder().encode(
      "marmot-ts signature key validation",
    );
    let valid = false;
    try {
      const signature = await ciphersuiteImpl.signature.sign(
        signatureKeyPair.signKey,
        challenge,
      );
      valid = await ciphersuiteImpl.signature.verify(
        signatureKeyPair.publicKey,
        challenge,
        signature,
      );
    } catch {
      /* Reject malformed or incompatible key material below. */
    }
    if (!valid)
      throw new Error("signatureKeyPair is incompatible with the ciphersuite");
  }
  const proof = await produceAccountIdentityProof({
    signer,
    accountIdentity: hexToBytes(accountPubkey),
    mlsSignatureKey: signatureKeyPair.publicKey,
    ciphersuite: ciphersuiteImpl.id,
    createdAt,
  });
  const leafNodeExtensions: CustomExtension[] = [
    makeLeafAppComponentsExtension(proof),
  ];

  return await MLSGenerateKeyPackageWithKey({
    credential,
    capabilities: resolvedCapabilities,
    lifetime: resolvedLifetime,
    extensions: resolvedExtensions,
    signatureKeyPair,
    leafNodeExtensions,
    cipherSuite: ciphersuiteImpl,
  });
}
