// Standalone packed TypeScript 6 contract; run with --ignoreConfig. If any
// erased legacy type reappears, its expect-error becomes unused and tsc fails.

// @ts-expect-error - The root no longer exports the legacy request type.
import type { AccountIdentityProofRequest } from "@internet-privacy/marmot-ts";
// @ts-expect-error - The root no longer exports the legacy proof type.
import type { AccountIdentityProof } from "@internet-privacy/marmot-ts";
// @ts-expect-error - The root no longer exports the legacy signed-event type.
import type { SignedAccountIdentityProofEvent } from "@internet-privacy/marmot-ts";
// @ts-expect-error - The root no longer exports the legacy event-signer type.
import type { AccountIdentityProofEventSigner } from "@internet-privacy/marmot-ts";
// @ts-expect-error - The root no longer exports the legacy signer type.
import type { AccountIdentityProofSigner } from "@internet-privacy/marmot-ts";

import type * as Core from "@internet-privacy/marmot-ts/core";

// Type namespace lookup also catches erased exports that runtime key scans miss.
// @ts-expect-error - Legacy request absent from the core type namespace.
export type LegacyRequestGuard = Core.AccountIdentityProofRequest;
// @ts-expect-error - Legacy proof absent from the core type namespace.
export type LegacyProofGuard = Core.AccountIdentityProof;
// @ts-expect-error - Legacy signed event absent from the core type namespace.
export type LegacySignedEventGuard = Core.SignedAccountIdentityProofEvent;
// @ts-expect-error - Legacy event signer absent from the core type namespace.
export type LegacyEventSignerGuard = Core.AccountIdentityProofEventSigner;
// @ts-expect-error - Legacy signer absent from the core type namespace.
export type LegacySignerGuard = Core.AccountIdentityProofSigner;
