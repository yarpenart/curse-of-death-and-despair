import assert from "node:assert/strict";
import test from "node:test";

import { hasAssignedCurseAccess } from "../scripts/quick-access.mjs";

const actors = new Map([
  ["cursed-owned", { id: "cursed-owned", owned: true }],
  ["cursed-other", { id: "cursed-other", owned: false }],
  ["healthy-owned", { id: "healthy-owned", owned: true }]
]);

const access = options => hasAssignedCurseAccess({
  victimActorIds: ["cursed-owned", "cursed-other"],
  getActor: id => actors.get(id),
  ownsActor: actor => actor.owned,
  ...options
});

test("GM always receives the curse shortcut", () => {
  assert.equal(access({ isGM: true, victimActorIds: [] }), true);
});

test("player receives the shortcut when they own a cursed actor", () => {
  assert.equal(access({ isGM: false }), true);
});

test("player without an assigned cursed actor does not receive the shortcut", () => {
  assert.equal(access({
    isGM: false,
    victimActorIds: ["cursed-other"],
    ownsActor: actor => actor.id === "healthy-owned"
  }), false);
});

test("missing victim actors do not grant access", () => {
  assert.equal(access({ isGM: false, victimActorIds: ["deleted-actor"] }), false);
});
