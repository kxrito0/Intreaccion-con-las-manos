/**
 * Unit tests for the pinch gesture math (spec S3, S4, S5, S6).
 *
 * Run with: node --test
 *
 * These tests cover the part of the app that can be proven without a camera.
 * The rendering and the real gesture stay manual (spec AC2-AC8).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PINCH_DEFAULTS,
  REJECTION,
  LANDMARK_INDEX,
  clamp,
  findLandmark,
  handScale,
  measureHand,
  advanceStability,
  isTracking,
  stepTracking,
  initialTrackingState,
  pinchRatio,
  normalizeRatio,
  diameterForRatio,
  smooth,
  nextDiameter,
} from "./pinch.js";

const SCALE = 100;

function approx(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

/**
 * A synthetic hand where the pinch ratio equals `ratio` exactly:
 * wrist (0,0) to middle_finger_mcp (0,SCALE) fixes the scale to SCALE, and the
 * thumb tip to index tip gap is `ratio * SCALE`.
 */
function hand(ratio) {
  return [
    { name: "wrist", x: 0, y: 0 },
    { name: "thumb_tip", x: 50, y: 0 },
    { name: "index_finger_tip", x: 50 + ratio * SCALE, y: 0 },
    { name: "middle_finger_mcp", x: 0, y: SCALE },
  ];
}

/** The same hand, but with no `name` on any landmark, so only indices can match. */
function handWithoutNames(ratio) {
  const keypoints = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  keypoints[LANDMARK_INDEX.wrist] = { x: 0, y: 0 };
  keypoints[LANDMARK_INDEX.thumb_tip] = { x: 50, y: 0 };
  keypoints[LANDMARK_INDEX.index_finger_tip] = { x: 50 + ratio * SCALE, y: 0 };
  keypoints[LANDMARK_INDEX.middle_finger_mcp] = { x: 0, y: SCALE };
  return keypoints;
}

// ---------------------------------------------------------------------------
// Landmark resolution (S2)
// ---------------------------------------------------------------------------

test("findLandmark resolves a landmark by name", () => {
  const thumb = findLandmark(hand(0.5), "thumb_tip");
  assert.equal(thumb.x, 50);
});

test("findLandmark falls back to the canonical index when names are absent", () => {
  const thumb = findLandmark(handWithoutNames(0.5), "thumb_tip");
  assert.equal(thumb.x, 50);
});

test("findLandmark returns null for a name with no index and no match", () => {
  assert.equal(findLandmark(hand(0.5), "pinky_tip"), null);
});

test("findLandmark does not use the index fallback on a partial landmark set", () => {
  // Position 0 of a 3-entry array is not the wrist, so resolving it by index
  // would silently measure the wrong joint and corrupt the palm scale.
  const partial = hand(0.8).filter((keypoint) => keypoint.name !== "wrist");
  assert.equal(findLandmark(partial, "wrist"), null);
});

test("findLandmark tolerates a malformed keypoint array", () => {
  assert.equal(findLandmark(null, "thumb_tip"), null);
  assert.equal(findLandmark([], "thumb_tip"), null);
  assert.equal(findLandmark([null], "thumb_tip"), null);
});

// ---------------------------------------------------------------------------
// Palm-scale normalisation (S3)
// ---------------------------------------------------------------------------

test("handScale measures wrist to middle finger MCP", () => {
  approx(handScale(hand(0.5)), SCALE);
});

test("pinchRatio equals the landmark gap divided by the palm scale", () => {
  approx(pinchRatio(hand(0.8)), 0.8);
});

test("pinchRatio is distance-invariant: moving the hand away does not change it", () => {
  const near = hand(0.8);
  const far = hand(0.8).map((kp) => ({ ...kp, x: kp.x * 4, y: kp.y * 4 }));
  approx(pinchRatio(far), pinchRatio(near));
});

test("pinchRatio returns null when a landmark is missing", () => {
  const incomplete = hand(0.8).filter((kp) => kp.name !== "index_finger_tip");
  assert.equal(pinchRatio(incomplete), null);
});

test("handScale returns null on a degenerate zero-length palm", () => {
  const degenerate = [
    { name: "wrist", x: 5, y: 5 },
    { name: "middle_finger_mcp", x: 5, y: 5 },
    { name: "thumb_tip", x: 0, y: 0 },
    { name: "index_finger_tip", x: 10, y: 0 },
  ];
  assert.equal(handScale(degenerate), null);
  assert.equal(pinchRatio(degenerate), null);
});

// ---------------------------------------------------------------------------
// Ratio to diameter mapping (S4)
// ---------------------------------------------------------------------------

test("normalizeRatio clamps a ratio at or below the pinch threshold to 0", () => {
  assert.equal(normalizeRatio(PINCH_DEFAULTS.minRatio - 1), 0);
  assert.equal(normalizeRatio(PINCH_DEFAULTS.minRatio), 0);
});

test("normalizeRatio clamps a ratio at or above the open threshold to 1", () => {
  assert.equal(normalizeRatio(PINCH_DEFAULTS.maxRatio + 5), 1);
  assert.equal(normalizeRatio(PINCH_DEFAULTS.maxRatio), 1);
});

test("normalizeRatio maps the midpoint of the range to 0.5", () => {
  const mid = (PINCH_DEFAULTS.minRatio + PINCH_DEFAULTS.maxRatio) / 2;
  approx(normalizeRatio(mid), 0.5);
});

test("normalizeRatio stays within 0..1 for a wide sweep of ratios", () => {
  for (let ratio = -2; ratio <= 5; ratio += 0.05) {
    const value = normalizeRatio(ratio);
    assert.ok(value >= 0 && value <= 1, `ratio ${ratio} produced ${value}`);
  }
});

test("normalizeRatio guards against an inverted or empty config", () => {
  assert.equal(normalizeRatio(1, { minRatio: 2, maxRatio: 2 }), 0);
  assert.equal(normalizeRatio(1, { minRatio: 2, maxRatio: 1 }), 0);
});

test("diameterForRatio maps the endpoints to the configured diameters", () => {
  approx(diameterForRatio(PINCH_DEFAULTS.minRatio), PINCH_DEFAULTS.minDiameter);
  approx(diameterForRatio(PINCH_DEFAULTS.maxRatio), PINCH_DEFAULTS.maxDiameter);
});

test("diameterForRatio never leaves the configured diameter range", () => {
  approx(diameterForRatio(0), PINCH_DEFAULTS.minDiameter);
  approx(diameterForRatio(99), PINCH_DEFAULTS.maxDiameter);
});

test("diameterForRatio is monotonic: opening the hand never shrinks the ball", () => {
  let previous = -Infinity;
  for (let ratio = 0; ratio <= 3; ratio += 0.02) {
    const diameter = diameterForRatio(ratio);
    assert.ok(diameter >= previous, `ratio ${ratio} decreased the diameter`);
    previous = diameter;
  }
});

test("clamp is inclusive of both bounds and tolerant of an inverted range", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(clamp(5, 10, 0), 5);
});

// ---------------------------------------------------------------------------
// Smoothing (S5)
// ---------------------------------------------------------------------------

test("smooth moves a fraction of the way toward the target", () => {
  approx(smooth(0, 100, 0.25), 25);
});

test("smooth never overshoots the target", () => {
  const value = smooth(90, 100, 1);
  assert.equal(value, 100);
});

test("smooth clamps an out-of-range factor instead of overshooting", () => {
  assert.equal(smooth(0, 100, 5), 100);
  assert.equal(smooth(0, 100, -5), 0);
});

// ---------------------------------------------------------------------------
// Frame update: the "hold last size" rule (S6)
// ---------------------------------------------------------------------------

test("nextDiameter snaps to the target on the first detection", () => {
  const target = diameterForRatio(0.8);
  approx(nextDiameter(hand(0.8), null), target);
});

test("nextDiameter holds the current size when no hand is present", () => {
  assert.equal(nextDiameter(null, 250), 250);
  assert.equal(nextDiameter([], 250), 250);
  assert.equal(nextDiameter(hand(0.8).filter((kp) => kp.name !== "wrist"), 250), 250);
});

test("nextDiameter stays null when there is no hand and no previous size", () => {
  assert.equal(nextDiameter(null, null), null);
});

test("nextDiameter smooths rather than jumping straight to the target", () => {
  const target = diameterForRatio(1.6);
  const next = nextDiameter(hand(1.6), 0);
  assert.ok(next > 0, "should move toward the target");
  assert.ok(next < target, "should not land on the target in a single frame");
});

test("nextDiameter converges to the target when the pose is held still", () => {
  const target = diameterForRatio(1.2);
  let diameter = 0;
  for (let i = 0; i < 400; i += 1) {
    diameter = nextDiameter(hand(1.2), diameter);
  }
  approx(diameter, target, 0.01);
});

test("nextDiameter is stable at rest: a still hand does not oscillate", () => {
  const settled = diameterForRatio(0.9);
  let diameter = settled;
  for (let i = 0; i < 200; i += 1) {
    diameter = nextDiameter(hand(0.9), diameter);
  }
  approx(diameter, settled, 0.001);
});

// ===========================================================================
// Signal acceptance gates and the frame reducer
//
// These cover the reported symptom: the ball sometimes changed size on its own
// when no pinch was happening. The causes were a garbage landmark frame being
// clamped to "fully open" (and therefore to maximum size), a palm too small on
// screen for the ratio to mean anything, and a single phantom frame being
// accepted immediately.
// ===========================================================================

/**
 * A synthetic hand with a full palm, so the rotation-robust scale estimator has
 * several palm segments to compare.
 *
 * @param palmSize          uniform scale; 0.1 models a distant, tiny hand.
 * @param palmLengthFactor  anisotropic squeeze of the palm LENGTH only, which
 *                          models the hand rotating towards the camera.
 */
function palmHand({ palmSize = 1, palmLengthFactor = 1, gap = 80 } = {}) {
  const palmLength = 100 * palmSize * palmLengthFactor;
  const palmWidth = 70 * palmSize;

  return [
    { name: "wrist", x: 0, y: 0 },
    { name: "middle_finger_mcp", x: 0, y: -palmLength },
    { name: "index_finger_mcp", x: -palmWidth / 2, y: -palmLength * 0.9 },
    { name: "pinky_mcp", x: palmWidth / 2, y: -palmLength * 0.85 },
    // The pinch pair, placed clear of the palm so only the two tips matter.
    { name: "thumb_tip", x: 300, y: 0 },
    { name: "index_finger_tip", x: 300 + gap, y: 0 },
  ];
}

/** Run a pose for many frames so the smoothing settles. */
function settle(state, pose, frames = 300) {
  let next = state;
  for (let i = 0; i < frames; i += 1) next = stepTracking(next, pose);
  return next;
}

// --- Gates -----------------------------------------------------------------

test("measureHand accepts a plausible, close hand", () => {
  const measurement = measureHand(palmHand({ gap: 80 }));
  assert.equal(measurement.accepted, true);
  assert.equal(measurement.reason, REJECTION.ok);
  approx(measurement.ratio, 0.8);
  approx(measurement.palmScale, 100);
});

test("measureHand rejects a frame whose gap cannot be a hand pose", () => {
  const measurement = measureHand(palmHand({ gap: 5000 }));
  assert.equal(measurement.accepted, false);
  assert.equal(measurement.reason, REJECTION.implausible);
});

test("measureHand rejects a hand that is too small on screen", () => {
  const measurement = measureHand(palmHand({ palmSize: 0.1, gap: 8 }));
  assert.equal(measurement.accepted, false);
  assert.equal(measurement.reason, REJECTION.handTooSmall);
  assert.ok(measurement.palmScale < PINCH_DEFAULTS.minPalmScale);
});

test("measureHand rejects a missing hand", () => {
  for (const input of [null, undefined, [], { keypoints: [] }]) {
    const measurement = measureHand(input);
    assert.equal(measurement.accepted, false);
    assert.equal(measurement.reason, REJECTION.noHand);
  }
});

test("measureHand rejects a low confidence detection when confidence is reported", () => {
  const measurement = measureHand({ keypoints: palmHand({ gap: 80 }), confidence: 0.1 });
  assert.equal(measurement.accepted, false);
  assert.equal(measurement.reason, REJECTION.lowConfidence);
});

test("measureHand does not gate on confidence when the model omits it", () => {
  // A missing field must mean "unknown", never zero, or a differently named
  // field would silently disable tracking entirely.
  const withoutConfidence = measureHand({ keypoints: palmHand({ gap: 80 }) });
  const withHighConfidence = measureHand({ keypoints: palmHand({ gap: 80 }), confidence: 0.95 });

  assert.equal(withoutConfidence.accepted, true);
  assert.equal(withHighConfidence.accepted, true);
  assert.equal(withoutConfidence.confidence, null);
});

// --- Rotation robustness ---------------------------------------------------

test("the palm scale loses less to foreshortening than a single palm segment", () => {
  const neutral = palmHand({ palmLengthFactor: 1 });
  const rotated = palmHand({ palmLengthFactor: 0.6 });

  const singleSegment = (keypoints) =>
    Math.hypot(
      findLandmark(keypoints, "wrist").x - findLandmark(keypoints, "middle_finger_mcp").x,
      findLandmark(keypoints, "wrist").y - findLandmark(keypoints, "middle_finger_mcp").y,
    );

  const robustLoss = 1 - handScale(rotated) / handScale(neutral);
  const singleLoss = 1 - singleSegment(rotated) / singleSegment(neutral);

  approx(handScale(neutral), 100);
  assert.ok(handScale(rotated) > 65, `rotated palm scale collapsed to ${handScale(rotated)}`);
  assert.ok(
    robustLoss < singleLoss,
    `robust loss ${robustLoss.toFixed(3)} should beat single-segment ${singleLoss.toFixed(3)}`,
  );
});

// --- Warm-up ---------------------------------------------------------------

test("advanceStability counts consecutive accepted frames and resets on rejection", () => {
  const config = { ...PINCH_DEFAULTS, warmupFrames: 3 };

  assert.equal(advanceStability(0, false, config), 0);
  assert.equal(advanceStability(0, true, config), 1);
  assert.equal(advanceStability(2, true, config), 3);
  assert.equal(advanceStability(3, true, config), 3);
  assert.equal(advanceStability(3, false, config), 0);
});

test("isTracking only reports true once the warm-up is complete", () => {
  const config = { ...PINCH_DEFAULTS, warmupFrames: 3 };
  assert.equal(isTracking(2, config), false);
  assert.equal(isTracking(3, config), true);
});

// --- The reported symptom --------------------------------------------------

test("the ball does not appear until the gesture is stable", () => {
  const pose = palmHand({ gap: 80 });
  let state = initialTrackingState();

  state = stepTracking(state, pose);
  assert.equal(state.diameter, null, "one frame should not be enough");
  state = stepTracking(state, pose);
  assert.equal(state.diameter, null, "two frames should not be enough");
  state = stepTracking(state, pose);
  assert.notEqual(state.diameter, null, "the third consecutive frame starts tracking");
});

test("a single garbage frame does not move the ball", () => {
  const pose = palmHand({ gap: 80 });
  let state = settle(initialTrackingState(), pose);
  const before = state.diameter;

  state = stepTracking(state, palmHand({ gap: 5000 }));

  assert.equal(state.measurement.accepted, false);
  assert.equal(state.diameter, before, "a rejected frame must hold the last size");
});

test("a mistimed phantom hand cannot make the ball appear", () => {
  const pose = palmHand({ gap: 80 });
  const garbage = palmHand({ gap: 5000 });
  let state = initialTrackingState();

  // Alternating good and garbage frames never accumulate the warm-up.
  for (let i = 0; i < 60; i += 1) {
    state = stepTracking(state, i % 2 === 0 ? pose : garbage);
  }

  assert.equal(state.diameter, null);
});

test("a distant tiny hand cannot swing the ball", () => {
  const pose = palmHand({ gap: 80 });
  let state = settle(initialTrackingState(), pose);
  const before = state.diameter;

  for (let i = 0; i < 30; i += 1) {
    state = stepTracking(state, palmHand({ palmSize: 0.1, gap: 8 }));
  }

  assert.equal(state.measurement.reason, REJECTION.handTooSmall);
  assert.equal(state.diameter, before);
});

test("rejected frames in the middle of a gesture hold the size instead of snapping", () => {
  const pinched = palmHand({ gap: 25 });
  let state = settle(initialTrackingState(), pinched);
  const held = state.diameter;

  state = stepTracking(state, null);
  assert.equal(state.diameter, held);

  state = stepTracking(state, palmHand({ gap: 5000 }));
  assert.equal(state.diameter, held);
});

test("a real pinch still drives the ball across the full range", () => {
  // Guards against over-blocking: the gates must not break the actual feature.
  let state = settle(initialTrackingState(), palmHand({ gap: 25 }));
  approx(state.diameter, PINCH_DEFAULTS.minDiameter, 1);

  state = settle(state, palmHand({ gap: 160 }));
  approx(state.diameter, PINCH_DEFAULTS.maxDiameter, 1);

  state = settle(state, palmHand({ gap: 25 }));
  approx(state.diameter, PINCH_DEFAULTS.minDiameter, 1);
});

test("a slow pinch tracks smoothly rather than jumping", () => {
  let state = initialTrackingState();
  const tracked = [];
  const steps = 90;

  for (let i = 0; i <= steps; i += 1) {
    const gap = 25 + (160 - 25) * (i / steps);
    state = stepTracking(state, palmHand({ gap }));
    // The first appearance snaps on purpose; measure smoothness after it.
    if (state.diameter !== null) tracked.push(state.diameter);
  }

  const biggestStep = Math.max(
    ...tracked.slice(1).map((size, index) => Math.abs(size - tracked[index])),
  );
  assert.ok(biggestStep < PINCH_DEFAULTS.maxDiameter / 20, `largest frame step was ${biggestStep}`);

  // Holding the fully open pose settles at the maximum.
  state = settle(state, palmHand({ gap: 160 }), 120);
  approx(state.diameter, PINCH_DEFAULTS.maxDiameter, 1);
});
