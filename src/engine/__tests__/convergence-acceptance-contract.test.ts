import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getEventHash } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  createApplicationMessage,
  createCommit,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  buildAdmin1PerspectiveChain,
  edgeFromReplay,
  seamGroup,
  snapshot,
  testPeeler,
} from "../../__tests__/helpers/engine-seam-fixtures.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../core/components/ids.js";
import {
  DEFAULT_CONVERGENCE_POLICY,
  isWitnessEligible,
  selectCanonicalBranch,
  type AppWitness,
  type BranchCandidate,
} from "../../core/convergence.js";
import { MarmotGroupEngine } from "../group-engine.js";
import { buildTreeBranchSet } from "../tree-convergence.js";

describe("historical convergence acceptance contract", () => {
  it("Phase 8 round 4 WR-03: a witnessed legal prefix cannot rewind its own current descendant", async () => {
    const f = await seamGroup();
    const policy = {
      ...DEFAULT_CONVERGENCE_POLICY,
      appPayloadPastEpochLimit: 1,
      witnessQuorumSendersPerEpoch: 1,
      maxWitnessOverrideDepth: 3,
      settlementQuiescenceMs: 0,
    };
    const create = (state: typeof f.admin2Epoch1, invalid = false) =>
      createCommit({
        context: f.ctx,
        state: snapshot(state),
        wireAsPublicMessage: true,
        extraProposals: invalid
          ? [
              {
                proposalType: appDataUpdateProposalType,
                appDataUpdate: {
                  componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
                  operation: "remove" as const,
                },
              },
            ]
          : [],
      });
    // R(1) -> A(2) -> C(3) -> T(4), A -> I(3, illegal), R -> E(2).
    // A's witness expires at T but counts at I and at the truncated A prefix.
    const a = await create(f.admin2Epoch1);
    const c = await create(a.newState);
    const t = await create(c.newState);
    const invalid = await create(a.newState, true);
    const external = await create(f.admin2Epoch1);
    const [aState, cState, tState] = await buildAdmin1PerspectiveChain(
      f.ctx,
      snapshot(f.adminEpoch1),
      [a.commit, c.commit, t.commit],
    );
    const [invalidState] = await buildAdmin1PerspectiveChain(
      f.ctx,
      snapshot(aState!),
      [invalid.commit],
    );
    const [externalState] = await buildAdmin1PerspectiveChain(
      f.ctx,
      snapshot(f.adminEpoch1),
      [external.commit],
    );
    const tags = {
      root: bytesToHex(f.adminEpoch1.confirmationTag),
      ancestor: bytesToHex(aState!.confirmationTag),
      intermediate: bytesToHex(cState!.confirmationTag),
      current: bytesToHex(tState!.confirmationTag),
      invalid: bytesToHex(invalidState!.confirmationTag),
      external: bytesToHex(externalState!.confirmationTag),
    };
    expect(new Set(Object.values(tags)).size).toBe(6);
    const peeler = testPeeler(f.impl);
    const engine = new MarmotGroupEngine({
      state: snapshot(f.adminEpoch1),
      ciphersuite: f.impl,
      peeler,
      convergencePolicy: policy,
    });
    // Advance only along the authenticated legal path before adding old edges.
    for (const [commit, parent] of [
      [a.commit, f.admin2Epoch1],
      [c.commit, a.newState],
      [t.commit, c.newState],
    ] as const) {
      const envelope = await peeler.wrapGroupMessage(commit, parent);
      for await (const result of engine.ingest([envelope])) void result;
    }
    expect(bytesToHex(engine.state.confirmationTag)).toBe(tags.current);
    engine.history.recordEdge(
      edgeFromReplay(tags.ancestor, invalid.commit, invalidState!),
    );
    engine.history.recordEdge(
      edgeFromReplay(tags.root, external.commit, externalState!),
    );
    expect(engine.history.tips().sort()).toEqual(
      [tags.current, tags.invalid, tags.external].sort(),
    );
    const set = buildTreeBranchSet(engine.history, tags.current, policy)!;
    expect(set.rootTag).toBe(tags.root);
    const witness: AppWitness = {
      epoch: 2,
      sender: hexToBytes(f.admin2Pubkey),
    };
    const candidates = set.candidates.map((candidate) => ({
      ...candidate,
      appWitnesses:
        engine.history.path(candidate.id)!.includes(tags.ancestor) &&
        isWitnessEligible(
          witness,
          candidate.forkEpoch,
          candidate.tipEpoch,
          policy,
        )
          ? [witness]
          : [],
    }));
    expect(selectCanonicalBranch(4, candidates, policy)?.id).toBe(tags.invalid);
    const prefix: BranchCandidate = {
      id: tags.ancestor,
      forkEpoch: 1,
      tipEpoch: 2,
      tipDigest: engine.history.node(tags.ancestor)!.edge!.commitDigest,
      appWitnesses: [witness],
    };
    expect(
      selectCanonicalBranch(
        4,
        [
          ...candidates.filter((candidate) => candidate.id !== tags.invalid),
          prefix,
        ],
        policy,
      )?.id,
    ).toBe(tags.ancestor);

    const rumor = {
      kind: 1,
      pubkey: f.admin2Pubkey,
      content: "WR-03 ancestor witness",
      tags: [],
      created_at: 1_700_000_000,
    };
    const app = await createApplicationMessage({
      context: f.ctx,
      state: snapshot(a.newState),
      message: new TextEncoder().encode(
        JSON.stringify({ ...rumor, id: getEventHash(rumor) }),
      ),
    });
    const envelope = await peeler.wrapGroupMessage(app.message, a.newState);
    for await (const result of engine.ingest([envelope])) void result;
    expect(bytesToHex(engine.state.confirmationTag)).toBe(tags.current);
    expect(engine.history.path(tags.current)).toContain(tags.ancestor);
    expect(engine.lifecycle).toBe("Stable");
  });
});
