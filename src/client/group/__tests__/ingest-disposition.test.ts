/**
 * Tests the mapping from ingest results to the inbound-processing Disposition
 * taxonomy (protocol-core/inbound-processing.md).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createCommit } from "ts-mls";

import { ingestResultDisposition, type IngestResult } from "../marmot-group.js";
import { seamGroup } from "../../../__tests__/helpers/engine-seam-fixtures.js";
import { createGroupEvent } from "../../../core/group-message.js";

let fixture: Pick<
  Extract<IngestResult, { kind: "processed" }>,
  "event" | "message" | "result"
>;

beforeAll(async () => {
  const { ctx, impl, adminEpoch1 } = await seamGroup();
  const commit = await createCommit({
    context: ctx,
    state: adminEpoch1,
    extraProposals: [],
  });
  fixture = {
    message: commit.commit,
    event: await createGroupEvent({
      message: commit.commit,
      state: adminEpoch1,
      ciphersuite: impl,
    }),
    result: {
      kind: "newState",
      newState: commit.newState,
      actionTaken: "accept",
      consumed: [],
      aad: new Uint8Array(),
    },
  };
});

describe("ingestResultDisposition", () => {
  it("maps processed to accepted", () => {
    expect(
      ingestResultDisposition({
        kind: "processed",
        ...fixture,
      }),
    ).toEqual({ kind: "accepted" });
  });

  it("maps rejected to a stale authorization_failed", () => {
    if (fixture.result.kind !== "newState")
      throw new Error("expected a commit result");
    expect(
      ingestResultDisposition({
        kind: "rejected",
        ...fixture,
        result: { ...fixture.result, actionTaken: "reject" },
      }),
    ).toEqual({ kind: "stale", category: "authorization_failed" });
  });

  it("maps skipped reasons to their categories", () => {
    const cases: Array<
      ["skipped", Extract<IngestResult, { kind: "skipped" }>["reason"], string]
    > = [
      ["skipped", "past-epoch", "already_applied"],
      ["skipped", "self-echo", "own_echo"],
      ["skipped", "wrong-wireformat", "invalid_encoding"],
      // Retained-anchor convergence outcomes (retained-history.md).
      ["skipped", "beyond-anchor", "missing_history"],
      ["skipped", "missing-retained-anchor", "missing_history"],
    ];
    for (const [, reason, category] of cases) {
      expect(
        ingestResultDisposition({
          kind: "skipped",
          reason,
          ...fixture,
        }),
      ).toEqual({ kind: "stale", category });
    }
  });

  it("maps unreadable to a terminal stale invalid_encoding", () => {
    expect(
      ingestResultDisposition({ kind: "unreadable", errors: [], ...fixture }),
    ).toEqual({ kind: "stale", category: "invalid_encoding" });
  });

  it("maps deferred to a retryable deferred carrying its reason", () => {
    const reasons = ["future_epoch", "missing_parent", "group_busy"] as const;
    for (const reason of reasons) {
      expect(
        ingestResultDisposition({
          kind: "deferred",
          reason,
          sourceEpoch: 1,
          ...fixture,
        }),
      ).toEqual({ kind: "deferred", reason });
    }
  });

  it("maps invalidated to an invalidated disposition (M7)", () => {
    expect(
      ingestResultDisposition({ kind: "invalidated", ...fixture }),
    ).toEqual({
      kind: "invalidated",
    });
  });
});
