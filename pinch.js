/**
 * Pure pinch-gesture math (spec S3, S4, S5, S6).
 *
 * This module deliberately has no dependency on p5, ml5 or the DOM. It takes
 * plain landmark objects and returns numbers, which is what keeps it
 * unit-testable outside a browser.
 *
 * Landmarks are ml5/MediaPipe hand keypoints: `{ x, y, name }`.
 */

// ---------------------------------------------------------------------------
// Tunable constants (spec S4). This is the only block expected to change while
// calibrating against a real camera. Turn the debug overlay on with `d` in the
// app to read the live ratio.
// ---------------------------------------------------------------------------

export const PINCH_DEFAULTS = Object.freeze({
  /** Ratio measured with thumb tip and index tip touching. */
  minRatio: 0.25,
  /** Ratio measured with the hand fully open. */
  maxRatio: 1.6,
  /** Ball diameter in pixels at `minRatio`. */
  minDiameter: 20,
  /** Ball diameter in pixels at `maxRatio`. */
  maxDiameter: 420,
  /** Lerp factor per frame. Lower is smoother but laggier. */
  smoothing: 0.18,

  // --- Signal acceptance gates -------------------------------------------
  // Without these, a single bad frame drives the ball to a size nobody asked
  // for. Each gate can only reject a frame; a rejected frame holds the last
  // size (spec S6).

  /**
   * Minimum palm size in pixels. The ratio divides by the palm, so a small
   * projected palm amplifies landmark noise: at a 10 px palm, 3 px of detector
   * jitter swings the ball across 22% of its range. Below this, the frame is
   * not measurable and is rejected.
   */
  minPalmScale: 30,
  /**
   * Largest ratio that can still be a real hand pose. The thumb tip to index
   * tip gap cannot exceed roughly 1.8 palms even fully spread, so anything
   * beyond this is a phantom or collapsed landmark set. Rejecting it matters:
   * clamping it instead would drive the ball to maximum size.
   */
  maxPlausibleRatio: 2.5,
  /** Consecutive acceptable frames required before the ball starts responding. */
  warmupFrames: 3,
  /**
   * Minimum detector confidence, applied only when the model actually reports
   * one. A missing confidence is treated as unknown, never as zero, so a
   * differently named field cannot silently disable tracking.
   */
  minConfidence: 0.5,
});

/**
 * Canonical MediaPipe hand landmark indices, used only as a fallback when a
 * keypoint carries no usable `name`.
 */
export const LANDMARK_INDEX = Object.freeze({
  wrist: 0,
  thumb_tip: 4,
  index_finger_mcp: 5,
  index_finger_tip: 8,
  middle_finger_mcp: 9,
  pinky_mcp: 17,
});

/**
 * Palm segments used to estimate how large the palm looks on screen.
 *
 * They are all rigid palm measurements that do not move during a pinch. Using
 * the longest of them is what makes the estimate rotation-tolerant: when the
 * hand turns towards or away from the camera, every palm segment foreshortens,
 * but not by the same amount, so the maximum is the one currently least
 * affected. Measuring a single segment makes the ball change size when you
 * merely rotate your hand.
 */
export const PALM_SEGMENTS = Object.freeze([
  Object.freeze(["wrist", "middle_finger_mcp"]),
  Object.freeze(["wrist", "index_finger_mcp"]),
  Object.freeze(["index_finger_mcp", "pinky_mcp"]),
]);

/** Landmarks this app needs for the pinch metric. */
export const REQUIRED_LANDMARKS = Object.freeze([
  "wrist",
  "thumb_tip",
  "index_finger_tip",
  "middle_finger_mcp",
]);

/** A complete MediaPipe hand has 21 landmarks, in a fixed canonical order. */
export const CANONICAL_LANDMARK_COUNT = 21;

// ---------------------------------------------------------------------------
// Landmark access (spec S2)
// ---------------------------------------------------------------------------

/**
 * Resolve one landmark by `name`, falling back to its canonical index.
 * Array order is not a contract, so the name always wins.
 *
 * @returns {object|null} the keypoint, or null when it cannot be resolved.
 */
export function findLandmark(keypoints, name) {
  if (!Array.isArray(keypoints)) return null;

  const byName = keypoints.find((keypoint) => keypoint && keypoint.name === name);
  if (byName) return byName;

  const index = LANDMARK_INDEX[name];
  if (index === undefined) return null;

  // The index fallback is only trustworthy for a *complete* landmark set. In a
  // partial array, position 0 is not necessarily the wrist, and silently
  // resolving the wrong joint corrupts the palm scale. Failing closed to null
  // makes the app hold its last size instead of measuring a phantom hand.
  if (keypoints.length < CANONICAL_LANDMARK_COUNT) return null;

  return keypoints[index] ?? null;
}

/**
 * Landmarks of a detected hand.
 *
 * ml5 exposes them under `keypoints`, some builds use `landmarks`. A bare
 * keypoint array is also accepted so callers and tests can pass either shape.
 *
 * @returns {Array|null}
 */
export function keypointsOf(hand) {
  if (!hand) return null;
  if (Array.isArray(hand)) return hand;
  return hand.keypoints ?? hand.landmarks ?? null;
}

/**
 * Confidence reported by the detector, when it reports one at all.
 *
 * @returns {number|null} null when the value is missing, which callers must
 *                        treat as "unknown" rather than as zero.
 */
export function handConfidence(hand) {
  if (!hand || Array.isArray(hand)) return null;
  const value = hand.confidence ?? hand.score;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Euclidean distance between two `{ x, y }` points. */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Palm-scale normalisation (spec S3)
// ---------------------------------------------------------------------------

/**
 * Palm scale = the longest palm segment currently visible, in pixels.
 *
 * Every segment in `PALM_SEGMENTS` is part of the rigid palm and does not move
 * during a pinch. Taking the longest of them matters because the palm is
 * measured in the 2D projection: rotating the hand foreshortens the segments,
 * but never all by the same amount, so the maximum is the estimate least
 * damaged by the current angle. With a single segment, simply turning your hand
 * changes the apparent palm size and therefore the ball size.
 *
 * @returns {number|null} null when no palm segment can be resolved, or when the
 *                        palm is degenerate.
 */
export function handScale(keypoints) {
  let longest = null;

  for (const [from, to] of PALM_SEGMENTS) {
    const a = findLandmark(keypoints, from);
    const b = findLandmark(keypoints, to);
    if (!a || !b) continue;

    const span = distance(a, b);
    if (Number.isFinite(span) && span > 0 && (longest === null || span > longest)) {
      longest = span;
    }
  }

  return longest;
}

/**
 * Pinch strength as a dimensionless ratio, so the same gesture reads the same
 * whether the hand is near or far from the camera.
 *
 * @returns {number|null} null when the gesture cannot be measured this frame.
 */
export function pinchRatio(keypoints) {
  const thumbTip = findLandmark(keypoints, "thumb_tip");
  const indexTip = findLandmark(keypoints, "index_finger_tip");
  if (!thumbTip || !indexTip) return null;

  const scale = handScale(keypoints);
  if (scale === null) return null;

  return distance(thumbTip, indexTip) / scale;
}

// ---------------------------------------------------------------------------
// Mapping (spec S4)
// ---------------------------------------------------------------------------

/** Clamp `value` into the inclusive range, tolerating an inverted range. */
export function clamp(value, min, max) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, lower), upper);
}

/**
 * Map a raw pinch ratio onto 0..1.
 *
 * Clamping is mandatory, not cosmetic: an open hand produces a ratio well above
 * `maxRatio`, and without the clamp the ball would grow past the canvas.
 *
 * @returns {number} 0 when pinched closed, 1 when fully open.
 */
export function normalizeRatio(ratio, config = PINCH_DEFAULTS) {
  const { minRatio, maxRatio } = config;
  if (!(maxRatio > minRatio)) return 0;

  return clamp((ratio - minRatio) / (maxRatio - minRatio), 0, 1);
}

/** Map a raw pinch ratio onto a ball diameter in pixels. */
export function diameterForRatio(ratio, config = PINCH_DEFAULTS) {
  const { minDiameter, maxDiameter } = config;
  return minDiameter + normalizeRatio(ratio, config) * (maxDiameter - minDiameter);
}

// ---------------------------------------------------------------------------
// Smoothing (spec S5)
// ---------------------------------------------------------------------------

/**
 * Move `current` a fraction of the way toward `target`.
 * Landmark coordinates jitter frame to frame; without this the ball vibrates.
 */
export function smooth(current, target, factor = PINCH_DEFAULTS.smoothing) {
  return current + (target - current) * clamp(factor, 0, 1);
}

// ---------------------------------------------------------------------------
// Per-frame update (S3 + S4 + S5 + S6 in one step)
// ---------------------------------------------------------------------------

/**
 * Compute the next ball diameter for a frame.
 *
 * @param {Array|null} keypoints     keypoints of the detected hand, or null.
 * @param {number|null} currentDiameter previous diameter, or null before the
 *                                     first detection.
 * @returns {number|null} the next diameter; the previous one when the gesture
 *                        cannot be measured (spec S6: hold, never snap).
 */
export function nextDiameter(keypoints, currentDiameter, config = PINCH_DEFAULTS) {
  const ratio = pinchRatio(keypoints);
  if (ratio === null) return currentDiameter;

  const target = diameterForRatio(ratio, config);

  // First ever detection: snap, so the ball does not animate up from nothing.
  if (currentDiameter === null || currentDiameter === undefined) return target;

  return smooth(currentDiameter, target, config.smoothing);
}

// ---------------------------------------------------------------------------
// Signal acceptance (gates)
//
// The detector sometimes emits frames that are not a hand pose: a phantom hand
// at the edge of the frame, a collapsed landmark set, a hand so small that the
// ratio is mostly noise. Feeding those into the mapping is what made the ball
// change size on its own, because clamping turns an absurd ratio into "fully
// open" and therefore into the maximum size.
//
// A gate can only REJECT a frame. A rejected frame holds the last size.
// ---------------------------------------------------------------------------

/** Reasons a frame can be rejected. Stable strings, safe to display. */
export const REJECTION = Object.freeze({
  ok: "ok",
  noHand: "no-hand",
  lowConfidence: "low-confidence",
  unmeasurable: "unmeasurable",
  handTooSmall: "hand-too-small",
  implausible: "implausible",
});

/**
 * Measure one detected hand, applying every acceptance gate.
 *
 * Pure: it inspects a single frame and returns a verdict. It does not remember
 * anything, which is what keeps the gates testable with synthetic landmarks.
 *
 * @param {object|Array|null} hand a detected hand, or a bare keypoint array.
 * @returns {{ accepted: boolean, reason: string, ratio: number|null,
 *             palmScale: number|null, confidence: number|null,
 *             keypoints: Array|null }}
 */
export function measureHand(hand, config = PINCH_DEFAULTS) {
  const keypoints = keypointsOf(hand);
  const confidence = handConfidence(hand);

  const reject = (reason, extra = {}) => ({
    accepted: false,
    reason,
    ratio: null,
    palmScale: null,
    confidence,
    keypoints,
    ...extra,
  });

  if (!keypoints || keypoints.length === 0) return reject(REJECTION.noHand);

  // Only gates when the model actually reports a confidence. A missing value is
  // unknown, not zero: gating on it would disable tracking entirely if the
  // installed build names the field differently.
  if (confidence !== null && confidence < config.minConfidence) {
    return reject(REJECTION.lowConfidence);
  }

  const palmScale = handScale(keypoints);
  if (palmScale === null) return reject(REJECTION.unmeasurable);

  if (palmScale < config.minPalmScale) {
    return reject(REJECTION.handTooSmall, { palmScale });
  }

  const ratio = pinchRatio(keypoints);
  if (ratio === null) return reject(REJECTION.unmeasurable, { palmScale });

  if (ratio > config.maxPlausibleRatio) {
    return reject(REJECTION.implausible, { palmScale, ratio });
  }

  return {
    accepted: true,
    reason: REJECTION.ok,
    ratio,
    palmScale,
    confidence,
    keypoints,
  };
}

/**
 * Advance the count of consecutive acceptable frames.
 *
 * Requiring several in a row is what stops a single phantom frame from making
 * the ball appear or jump. Any rejection resets the count, so the ball pauses
 * on a bad frame instead of following it.
 */
export function advanceStability(previous, accepted, config = PINCH_DEFAULTS) {
  if (!accepted) return 0;
  return Math.min(previous + 1, config.warmupFrames);
}

/** True once enough consecutive acceptable frames have been seen. */
export function isTracking(stableFrames, config = PINCH_DEFAULTS) {
  return stableFrames >= config.warmupFrames;
}

// ---------------------------------------------------------------------------
// Frame reducer
// ---------------------------------------------------------------------------

/** Tracking state as it flows from frame to frame. */
export function initialTrackingState() {
  return { diameter: null, stableFrames: 0 };
}

/**
 * Reduce one frame into the next tracking state (gates + warm-up + mapping).
 *
 * This is the whole per-frame decision in one pure function, so the behaviour
 * that used to live inside the render loop is testable: feed it a sequence of
 * synthetic hands and assert what the ball does.
 *
 * @param {{ diameter: number|null, stableFrames: number }} state
 * @param {object|Array|null} hand a detected hand, or a bare keypoint array.
 */
export function stepTracking(state, hand, config = PINCH_DEFAULTS) {
  const measurement = measureHand(hand, config);
  const stableFrames = advanceStability(state.stableFrames, measurement.accepted, config);
  const tracking = isTracking(stableFrames, config);

  // Only a gated measurement that survived the warm-up may move the ball.
  // Everything else holds the previous size (spec S6).
  const diameter = tracking
    ? nextDiameter(measurement.keypoints, state.diameter, config)
    : state.diameter;

  return { diameter, stableFrames, tracking, measurement };
}
