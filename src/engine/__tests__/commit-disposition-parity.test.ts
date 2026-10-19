/** Real MLS processing with an explicitly injected post-processing capture fault.
 * This is not a reproduction of the historical external-commit wire trigger. */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  createCommit,
  createProposal,
  createGroupInfoWithExternalPubAndRatchetTree,
  defaultProposalTypes,
  joinGroupExternal,
  processMessage,
} from "ts-mls";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  seamGroup,
  snapshot,
  testPeeler,
} from "../../__tests__/helpers/engine-seam-fixtures.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { marmotAuthService } from "../../core/auth-service.js";
import { createCredential } from "../../core/credential.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import * as adminPolicy from "../admin-policy.js";
import { resolveCandidateParent } from "../fork-recovery.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { IngestResult } from "../types.js";

const realCapture = adminPolicy.withCapturedProposals;
const terminal = {
  reason: "account-identity-proof",
  proofReason: "unattributable-leaf",
};

function faultCapture(complete: boolean) {
  let captures = 0;
  vi.spyOn(adminPolicy, "withCapturedProposals").mockImplementation((inner) => {
    const capture = realCapture(inner);
    return {
      callback: capture.callback,
      take() {
        const captured = capture.take();
        // Only alter a result after the real authenticated member callback ran.
        if (captured.committerLeafIndex === undefined) return captured;
        captures++;
        return { ...captured, complete, committerLeafIndex: undefined };
      },
    };
  });
  return () => captures;
}

async function ingestAll(
  engine: MarmotGroupEngine<NostrEvent>,
  envelope: NostrEvent,
) {
  const results: IngestResult<NostrEvent>[] = [];
  for await (const result of engine.ingest([envelope])) results.push(result);
  return results;
}

afterEach(() => vi.restoreAllMocks());

describe("post-processing capture fault after real MLS processing", () => {
  it.each([true, false])(
    "direct ingest complete=%s distinguishes terminal attribution from incomplete capture",
    async (complete) => {
      const f = await seamGroup();
      const peeler = testPeeler(f.impl);
      const engine = new MarmotGroupEngine({
        state: snapshot(f.adminEpoch1),
        ciphersuite: f.impl,
        peeler,
        settlementQuiescenceMs: 0,
      });
      const parentTag = bytesToHex(engine.state.confirmationTag);
      const commit = await createCommit({
        context: f.ctx,
        state: snapshot(f.admin2Epoch1),
        wireAsPublicMessage: true,
      });
      const envelope = await peeler.wrapGroupMessage(
        commit.commit,
        f.admin2Epoch1,
      );
      const captures = faultCapture(complete);
      const results = await ingestAll(engine, envelope);
      expect(captures()).toBeGreaterThan(0);
      const result = results.find(
        (r) => r.kind === (complete ? "rejected" : "deferred"),
      );
      expect(result).toBeDefined();
      expect(result).toMatchObject(
        complete ? terminal : { reason: "unjudgeable_identity" },
      );
      expect(bytesToHex(engine.state.confirmationTag)).toBe(parentTag);
      expect(
        engine.history.node(bytesToHex(commit.newState.confirmationTag)),
      ).toBeUndefined();
    },
  );

  it.each([true, false])(
    "replay complete=%s distinguishes terminal attribution from incomplete capture",
    async (complete) => {
      const f = await seamGroup();
      const parent = snapshot(f.adminEpoch1);
      const commit = await createCommit({
        context: f.ctx,
        state: snapshot(f.admin2Epoch1),
        wireAsPublicMessage: true,
      });
      const captures = faultCapture(complete);
      const result = await resolveCandidateParent({
        ciphersuite: f.impl,
        parent,
        message: commit.commit,
        callback: adminPolicy.createAdminCommitPolicyCallback({
          ratchetTree: parent.ratchetTree,
          adminPubkeys: getMarmotGroupView(parent)!.adminPubkeys,
          ciphersuiteId: f.impl.id,
        }),
      });
      expect(captures()).toBe(1);
      expect(result.kind).toBe(complete ? "rejected" : "deferred");
      if (complete) expect(result).toMatchObject({ violation: terminal });
    },
  );

  it.each([true, false])(
    "pool sweep complete=%s consumes terminal work and retains incomplete work without an edge",
    async (complete) => {
      const f = await seamGroup();
      const peeler = testPeeler(f.impl);
      const engine = new MarmotGroupEngine({
        state: snapshot(f.adminEpoch1),
        ciphersuite: f.impl,
        peeler,
        settlementQuiescenceMs: 0,
      });
      for (let i = 0; i < 2; i++) {
        const own = await engine.send({
          kind: "commit",
          actorPubkey: f.adminPubkey,
          extraProposals: [],
        });
        if (own.kind !== "groupEvolution")
          throw new Error("expected groupEvolution");
        engine.confirmPublished(own.pending);
      }
      const ownTag = bytesToHex(engine.state.confirmationTag);
      const sibling = await createCommit({
        context: f.ctx,
        state: snapshot(f.admin2Epoch1),
        wireAsPublicMessage: true,
      });
      await ingestAll(
        engine,
        await peeler.wrapGroupMessage(sibling.commit, f.admin2Epoch1),
      );
      expect(
        engine.history.node(bytesToHex(sibling.newState.confirmationTag)),
      ).toBeDefined();
      const next = await createCommit({
        context: f.ctx,
        state: sibling.newState,
        wireAsPublicMessage: true,
      });
      const envelope = await peeler.wrapGroupMessage(
        next.commit,
        sibling.newState,
      );
      const captures = faultCapture(complete);
      const results = await ingestAll(engine, envelope);
      expect(captures()).toBeGreaterThan(0);
      expect(results.filter((r) => r.kind === "rejected")).toHaveLength(
        complete ? 1 : 0,
      );
      if (complete)
        expect(results.find((r) => r.kind === "rejected")).toMatchObject(
          terminal,
        );
      expect(
        engine.history.node(bytesToHex(next.newState.confirmationTag)),
      ).toBeUndefined();
      expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);
      const capturedBeforeRetry = captures();
      for await (const _result of engine.ingest([])) {
        /* Fully drain retries. */
      }
      if (complete) expect(captures()).toBe(capturedBeforeRetry);
      // Sweep attempts are memoized per node: retained work is retried when the
      // node's inputs change, rather than spinning against the same snapshot.
      else expect(engine.pendingCount).toBe(1);
      if (complete) expect(engine.pendingCount).toBe(0);
      expect(engine.convergenceStatus).toBe("Settled");
      expect(engine.lifecycle).toBe("Stable");
    },
  );
});

describe("production policy and genuine dependency controls", () => {
  async function keyPackage(f: Awaited<ReturnType<typeof seamGroup>>) {
    const account = testAccount(9);
    return generateKeyPackage({
      credential: createCredential(account.pubkey),
      signer: account.signer,
      ciphersuiteImpl: f.impl,
    });
  }

  function policy(f: Awaited<ReturnType<typeof seamGroup>>) {
    return adminPolicy.createAdminCommitPolicyCallback({
      ratchetTree: f.adminEpoch1.ratchetTree,
      adminPubkeys: getMarmotGroupView(f.adminEpoch1)!.adminPubkeys,
      ciphersuiteId: f.impl.id,
    });
  }

  it("genuine external commit is rejected by current admin policy before historical post-apply attribution", async () => {
    const f = await seamGroup();
    const context = { cipherSuite: f.impl, authService: marmotAuthService };
    const kp = await keyPackage(f);
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
      snapshot(f.admin2Epoch1),
      [],
      f.impl,
    );
    const external = await joinGroupExternal({
      context,
      groupInfo,
      keyPackage: kp.publicPackage,
      privateKeys: kp.privatePackage,
      resync: false,
    });
    const callback = vi.fn(policy(f));
    const capture = realCapture(callback);
    expect(capture.take().complete).toBe(false);
    const result = await processMessage({
      context,
      state: snapshot(f.adminEpoch1),
      message: external.commit,
      callback: capture.callback,
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "commit", senderLeafIndex: undefined }),
    );
    expect(result).toMatchObject({ kind: "newState", actionTaken: "reject" });
    expect(capture.take()).toMatchObject({
      complete: true,
      committerLeafIndex: undefined,
    });
    expect(capture.take()).toMatchObject({
      complete: false,
      proposals: [],
      committerLeafIndex: undefined,
    });
    const replay = await resolveCandidateParent({
      ciphersuite: f.impl,
      parent: snapshot(f.adminEpoch1),
      message: external.commit,
      callback: policy(f),
    });
    expect(replay.kind).toBe("rejected");
    const peeler = testPeeler(f.impl);
    const engine = new MarmotGroupEngine({
      state: snapshot(f.adminEpoch1),
      ciphersuite: f.impl,
      peeler,
    });
    const results = await ingestAll(
      engine,
      await peeler.wrapGroupMessage(external.commit, f.adminEpoch1),
    );
    expect(results.find((r) => r.kind === "rejected")).toMatchObject({
      reason: "admin-policy",
    });
    expect(engine.state.groupContext.epoch).toBe(
      f.adminEpoch1.groupContext.epoch,
    );
  });

  it("missing proposal retries successfully after arrival and known-child recovery stays accepted", async () => {
    const f = await seamGroup();
    const proposal = await createProposal({
      context: f.ctx,
      state: snapshot(f.admin2Epoch1),
      wireAsPublicMessage: true,
      proposal: {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: (await keyPackage(f)).publicPackage },
      },
    });
    const commit = await createCommit({
      context: f.ctx,
      state: proposal.newState,
      wireAsPublicMessage: true,
    });
    const capture = realCapture(policy(f));
    const missing = await resolveCandidateParent({
      ciphersuite: f.impl,
      parent: snapshot(f.adminEpoch1),
      message: commit.commit,
      callback: capture.callback,
    });
    // Existing replay contract: no callback completes before reference resolution.
    expect(missing.kind).toBe("authentication_mismatch");
    expect(capture.take().complete).toBe(false);
    const peeler = testPeeler(f.impl);
    const engine = new MarmotGroupEngine({
      state: snapshot(f.adminEpoch1),
      ciphersuite: f.impl,
      peeler,
    });
    const envelope = await peeler.wrapGroupMessage(
      commit.commit,
      f.adminEpoch1,
    );
    const before = await ingestAll(engine, envelope);
    // Existing direct contract reports the unresolved reference as unreadable,
    // but does not remember the commit in dedup: redelivery remains possible.
    expect(before.find((r) => r.kind === "unreadable")).toBeDefined();
    expect(engine.state.groupContext.epoch).toBe(
      f.adminEpoch1.groupContext.epoch,
    );
    await ingestAll(
      engine,
      await peeler.wrapGroupMessage(proposal.message, f.adminEpoch1),
    );
    const stagedParent = snapshot(engine.state);
    const after = await ingestAll(engine, envelope);
    expect(after.find((r) => r.kind === "processed")).toBeDefined();
    const replay = await resolveCandidateParent({
      ciphersuite: f.impl,
      parent: stagedParent,
      message: commit.commit,
      callback: policy(f),
    });
    expect(replay.kind).toBe("resolved");
    // Original proposals absent: only the trusted, exactly stamped known child
    // uses the accepted proposal-independent checks, outside capture policy.
    const known = await resolveCandidateParent({
      ciphersuite: f.impl,
      parent: snapshot(f.adminEpoch1),
      message: commit.commit,
      callback: policy(f),
      known: {
        parentTag: bytesToHex(f.adminEpoch1.confirmationTag),
        state: snapshot(engine.state),
      },
    });
    expect(known.kind).toBe("resolved");
  });

  it("genuine missing parent stays deferred and applies once the intermediate commit arrives", async () => {
    const f = await seamGroup();
    const first = await createCommit({
      context: f.ctx,
      state: snapshot(f.admin2Epoch1),
      wireAsPublicMessage: true,
    });
    const second = await createCommit({
      context: f.ctx,
      state: first.newState,
      wireAsPublicMessage: true,
    });
    const third = await createCommit({
      context: f.ctx,
      state: second.newState,
      wireAsPublicMessage: true,
    });
    const messages = new Map([
      ["first", first.commit],
      ["second", second.commit],
      ["third", third.commit],
    ]);
    // Already peeled real wire messages isolate the missing-parent epoch gate.
    const engine = new MarmotGroupEngine({
      state: snapshot(f.adminEpoch1),
      ciphersuite: f.impl,
      peeler: {
        async peelGroupMessages(envelopes: { id: string }[]) {
          return {
            read: envelopes.map((envelope) => ({
              envelope,
              message: messages.get(envelope.id)!,
            })),
            unreadable: [],
          };
        },
        wrapGroupMessage() {
          throw new Error("not used");
        },
        idOf(envelope: { id: string }) {
          return envelope.id;
        },
      },
    });
    const results = [];
    for await (const result of engine.ingest([{ id: "third" }]))
      results.push(result);
    expect(results.find((r) => r.kind === "deferred")).toMatchObject({
      reason: "missing_parent",
    });
    for await (const _result of engine.ingest([
      { id: "first" },
      { id: "second" },
    ])) {
      /* Drain pooled retry. */
    }
    expect(bytesToHex(engine.state.confirmationTag)).toBe(
      bytesToHex(third.newState.confirmationTag),
    );
  });
});
