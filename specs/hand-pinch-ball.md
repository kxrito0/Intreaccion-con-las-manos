# Spec: Pinch-to-Size Ball (hand tracking)

- **Status:** APPROVED — implemented, verified. `AC2`–`AC8` pending a real webcam (see §11).
- **Process:** SDD — spec-first. This document is the source of truth for the feature.
- **Date:** 2026-10-15
- **Feature name:** `hand-pinch-ball`

---

## 1. Objective

A single-page web app that reads the webcam, detects **one hand**, and maps the
**pinch gesture between thumb tip and index finger tip** to the **diameter of a ball** drawn on screen.

- Pinch closed (thumb + index touching) -> ball at **minimum** size.
- Hand open (thumb + index apart) -> ball at **maximum** size.
- Anything in between -> proportional size, updated live.

No build step, no bundler, no framework. Libraries come from CDNs.

## 2. Stack (pinned and verified)

| Component | Version | CDN URL | Verified |
| --- | --- | --- | --- |
| p5.js | `2.3.4` | `https://cdn.jsdelivr.net/npm/p5@2.3.4/lib/p5.min.js` | HTTP 200, 988,497 bytes, bundle self-reports `2.3.4` |
| ml5.js | `1.4.0` | `https://cdn.jsdelivr.net/npm/ml5@1.4.0/dist/ml5.min.js` | HTTP 200, 4,512,243 bytes |

Notes verified during specification:

- The p5.js 2.x **global** build lives at `lib/p5.min.js`. The path `dist/p5.min.js` returns **404** for 2.x.
- p5.js 2.x introduces **async `setup()`**, which replaces the need for `preload()`. This app loads the ml5 model with `await` inside `setup()`.
- ml5.js 1.4.0 ships an explicit **"p5.js 2.0 Examples"** set that includes `handPose-keypoints`, `handPose-parts` and `handPose-skeletal-connections`, so p5.js 2.x is a supported combination. **No need to downgrade p5.js.**
- Equivalent verified fallbacks if a CDN is unreachable: `https://unpkg.com/...` and `https://cdnjs.cloudflare.com/ajax/libs/p5.js/2.3.4/p5.min.js` (all returned identical bytes for p5).
- **Documented contingency:** if p5.js 2.3.4 misbehaves at runtime with ml5, pin p5.js `1.11.13`
  (`https://cdn.jsdelivr.net/npm/p5@1.11.13/lib/p5.min.js`, verified HTTP 200) and change nothing else.

## 3. Runtime requirements

| Requirement | Detail |
| --- | --- |
| Secure context | `getUserMedia` requires `https://` or `http://localhost`. **Opening `index.html` via `file://` will fail to get the camera.** The project ships its own server for this. |
| Local server | Python is **not installed** on this machine (only Microsoft Store stubs), and `npx serve` requires a network download. Therefore the project ships a **zero-dependency `server.js`** using Node's built-in `http` module. Run with `node server.js`. |
| Internet at runtime | ml5 fetches the MediaPipe hand model at runtime, not only at page load. |
| Browser | Chromium-based browser or Firefox with webcam permission granted. |
| Node | Present: `v24.22.0`. Only used for the static server and the math tests. |

## 4. File layout

```
index.html                 page shell, CDN <script> tags, status overlay
sketch.js                  p5 sketch: camera, ml5 handPose, drawing (module)
pinch.js                   pure gesture math — no DOM, no p5, no ml5 (module)
pinch.test.js              unit tests for pinch.js, run with `node --test`
server.js                  zero-dependency static server for localhost
README.md                  how to run + controls
specs/hand-pinch-ball.md   this document
```

`pinch.js` is deliberately isolated: it holds all the non-trivial logic and has **no** dependency on
p5, ml5 or the DOM, which is what makes it unit-testable.

## 5. Requirements

### S1 — Camera preview
The app shows a live webcam preview, **mirrored** (selfie view), aspect-correct inside the canvas.

### S2 — Hand landmark detection
The app detects up to one hand via `ml5.handPose()` and keeps only the first detected hand.
Landmarks must be resolved **by their `name` property**, with a numeric index fallback, because
array order is not a contract:

| Landmark | ml5 `name` | Canonical index |
| --- | --- | --- |
| Wrist | `wrist` | 0 |
| Thumb tip | `thumb_tip` | 4 |
| Index finger tip | `index_finger_tip` | 8 |
| Middle finger MCP | `middle_finger_mcp` | 9 |

### S3 — Distance-invariant pinch metric
The pinch strength is **normalized by palm scale**, not used as a raw pixel distance, so the gesture
behaves identically whether the hand is 40 cm or 120 cm from the camera:

```
handScale  = dist(wrist, middle_finger_mcp)          // stable during a pinch
pinchRatio = dist(thumb_tip, index_finger_tip) / handScale
```

`middle_finger_mcp` is used as the scale reference because that segment is part of the rigid palm and
does not move when the thumb and index come together.

### S4 — Ratio to diameter mapping
```
normalized(r) = clamp((r - MIN_RATIO) / (MAX_RATIO - MIN_RATIO), 0, 1)
diameter(n)   = MIN_DIAMETER + n * (MAX_DIAMETER - MIN_DIAMETER)
```
Clamping is mandatory: without it, an open hand produces a ratio far above `MAX_RATIO` and the ball
grows past the screen.

Tunable constants (single block, at the top of `pinch.js`):

| Constant | Initial value | Meaning |
| --- | --- | --- |
| `MIN_RATIO` | `0.25` | ratio measured with thumb and index touching |
| `MAX_RATIO` | `1.60` | ratio measured with the hand fully open |
| `MIN_DIAMETER` | `20` | px, at `MIN_RATIO` |
| `MAX_DIAMETER` | `420` | px, at `MAX_RATIO` |
| `SMOOTHING` | `0.18` | lerp factor per frame |

`MIN_RATIO` and `MAX_RATIO` are calibration values that must be confirmed against a real webcam and
adjusted if needed. They are the only values expected to change during tuning.

### S5 — Smoothing
Landmarks jitter frame to frame, so the raw diameter is smoothed with a lerp:
`smooth = current + (target - current) * SMOOTHING`. Requirement: with a stationary hand, the drawn
diameter must not visibly oscillate.

### S6 — Hold on hand loss
When no hand is detected, the ball **keeps its last size** and does not snap to a default or to zero.

### S7 — Status and error reporting
A visible in-page overlay reports state instead of failing silently:

- `Loading model…` while the ml5 model initializes.
- `Camera ready` once the stream starts.
- `No hand detected` when the frame has no hand.
- A readable message if the camera is denied/unavailable, instead of a black canvas.
- A readable message if `window.p5` or `window.ml5` is undefined (CDN unreachable).
- A readable message if the ml5 model fails to load.

### S8 — Debug overlay
Pressing `d` toggles an overlay drawing the detected landmarks, the live ratio, the palm size in pixels, the
gate verdict, the warm-up counter and the current diameter. It exists to make the gesture inspectable while
tuning.

### S9 — Signal acceptance gates
A detected hand must not reach the size mapping unverified. Every frame passes through gates, and a gate can
only **reject** a frame; a rejected frame holds the last size (S6).

| Gate | Rejects when |
| --- | --- |
| `minPalmScale` | the palm measures less than 30 px, where the ratio is dominated by landmark noise |
| `maxPlausibleRatio` | the ratio exceeds 2.5, which cannot be a real hand pose |
| `minConfidence` | the detector reports a confidence below 0.5, checked **only** when it reports one |
| `warmupFrames` | fewer than 3 *consecutive* acceptable frames have been seen |

Rationale, recorded for the change that introduced this: clamping an implausible ratio turns it into
"fully open" and drives the ball to maximum size, which is indistinguishable from the ball appearing on its
own. A missing confidence value must be treated as unknown, never as zero, or a differently named field in
the installed ml5 build would disable tracking entirely.

Any rejection resets the warm-up counter, so a bad frame pauses the ball instead of moving it.

### S10 — The paused state must be explained
When the ball is not following the hand, the status line names the gate responsible (for example
`Hand too far from the camera`), so a paused ball is never a mystery.

## 6. Acceptance criteria

Each one is checkable by hand in the browser unless noted.

| ID | Criterion |
| --- | --- |
| AC1 | Page loads with both CDNs reachable and no console errors. |
| AC2 | Camera preview is visible and mirrored; drawn landmarks align with the video. |
| AC3 | Fully pinched thumb+index -> ball at `MIN_DIAMETER`; fully open hand -> ball at `MAX_DIAMETER`; size changes monotonically in between. |
| AC4 | With the hand held still, the diameter does not visibly oscillate (S5). |
| AC5 | The gesture produces the same size range at roughly 40 cm and roughly 120 cm from the camera (S3). |
| AC6 | Removing the hand from frame leaves the ball at its last size (S6). |
| AC7 | Denying camera permission shows an in-page message and does not crash (S7). |
| AC8 | `d` toggles the debug overlay (S8). |
| AC9 | `pinch.test.js` passes under `node --test` (S3, S4, S5). |
| AC10 | `node server.js` serves the project on `http://localhost:<port>` and the page loads from there. |
| AC11 | No single frame can move the ball to a size the user did not ask for: a garbage, phantom, distant or low-confidence frame is rejected and holds the last size, and alternating good/bad frames never let the ball appear (S9). |
| AC12 | The gates do not break the feature: a real pinch still drives the ball across the full range, and a slow pinch tracks smoothly without per-frame jumps (S9). |

## 7. Verification plan

**Automated (I can run these):**

- AC9 — `node --test pinch.test.js` over the pure functions: clamp bounds, normalization endpoints,
  monotonicity, hand-scale normalization, smoothing convergence, and landmark name/index resolution.
- AC10 — start the server and assert it serves `index.html` with HTTP 200.
- AC1 (partial) — assert the CDN URLs return 200 and that the module files parse (`node --check`).
  This does not prove the browser ran them.

**Manual (only you can do these):** AC2–AC8. They need a real webcam and a real hand. There is no way
for me to drive a physical gesture, so these stay as your check.

This is the honest verification boundary: the pure math is proven by tests, everything involving the
camera or the rendering is proven by your eyes.

## 8. Out of scope

Explicitly **not** included, to keep the first version small:

- Two hands at once and pinch-per-hand.
- Depth / `z` landmark use, 3D rendering.
- Slow-motion, recording, screenshots, exporting data.
- Mobile-specific layout or touch controls.
- Any build tooling, bundler, TypeScript, or dependency install step.
- Deployment, hosting, or CI.
- Gestures other than pinch (fist, open palm, point) as commands.
- Persisted calibration across reloads.

## 9. Risks and assumptions

| # | Item | Mitigation |
| --- | --- | --- |
| R1 | `MIN_RATIO` / `MAX_RATIO` are estimated, not measured on your hand and camera. | They live in one exported constants block and are the intended tuning point. The debug overlay (S8) exists for exactly this. |
| R2 | p5.js 2.x is a recent major and ml5 integration is newer than the p5 1.x path. | Contingency pin documented in section 2. `pinch.js` has no p5 dependency, so a p5 downgrade touches only `sketch.js` + `index.html`. |
| R3 | ml5 fetches model weights from the network at runtime; a blocked network or ad-blocker can break detection. | Surfaced as a readable status message (S7). |
| R4 | Assumption: the mirrored preview is wanted (standard for webcam apps). | Stated as S1; easy to flip if not. |
| R5 | Assumption: one hand is enough. | Stated as S2 and in out-of-scope. |

## 10. Proposed next steps (after approval)

1. `git init` plus an initial commit of this spec, so the spec is reviewable history. *(Not run yet — needs your go-ahead.)*
2. Write `pinch.test.js` first and observe it fail (RED).
3. Implement `pinch.js` until the tests pass (GREEN).
4. Implement `server.js`, `index.html`, `sketch.js`, `README.md`.
5. Run AC9 and AC10, then hand AC1–AC8 over to you for the webcam check.

## 11. Log

### L1 — Original request (2026-10-15)

> quiero iniciar un nuevo proyecto con SDD quiero que utilices P5.js con CDN tambien vas a utilizar ML5.js con CDN la aplicación va a utlizar reconocimiento de manos con la cámara de la web quiero que yo al mover el inidice y el pulgar haciendo el gesto de pinch con el indice y el pulgar cambie el tamaño de una pelota

Clarification recorded: no SDD convention is installed in the global config or the project, so SDD was
interpreted as spec-first (spec written and approved before implementation). If GitHub Spec Kit
(`.specify/`) was meant instead, only the document location changes.

### L2 — Approval (2026-10-15)

The spec was approved and implementation started, test-first.

### L3 — Verification evidence (2026-10-15)

**`pinch.test.js` — RED then GREEN.** The suite failed first with `ERR_MODULE_NOT_FOUND`, then with a real
assertion failure that exposed a genuine bug: the landmark index fallback resolved `wrist` to the position of
`thumb_tip` in a partial keypoint array, silently corrupting the palm scale. Fixed by restricting the index
fallback to complete 21-landmark sets (`CANONICAL_LANDMARK_COUNT`), so a malformed input fails closed to
`null` and the app holds its last size instead of measuring a phantom hand. A test now pins that rule.

**`server.js` — independent verification found a blocker.** The parent declared this file high risk
(item 2: it implements a filesystem access guard) and delegated verification to a separate agent. Its
verdict on the claim "no request can read a file outside the served root" was **does not hold**: the guard
was purely lexical, so a junction/symlink placed *inside* the served root passed the string prefix check and
`stat`/`readFile` then followed it out of the tree. `GET /link/secret.txt` returned `200` with the outside
file's contents.

Fixed by comparing **real paths** (`realpath`) for the root and the resolved target before serving, on top of
the existing lexical check. The verifier's probes were committed as `server.guard.test.js` and observed RED
(`/link/secret.txt returned 200`) before the fix and GREEN after it. Every request-controlled traversal
vector was blocked both before and after: encoded `%2f`/`%5c`, mixed case, double encoding, absolute and
drive-relative paths, UNC and device paths, NUL bytes, invalid UTF-8 and overlong targets.

### L4 — Verification status (2026-10-15)

| AC | Status | Evidence |
| --- | --- | --- |
| AC1 | **partial** | Both pinned CDN URLs return HTTP 200 with the expected byte sizes; `node --check` passes on every module; the page and its module graph serve correctly. The browser execution itself is covered by AC2–AC8. |
| AC2–AC8 | **pending** | Need a real webcam and a real hand. Not automatable here. |
| AC9 | **pass** | `node --test` → 42 tests, 42 pass, 0 fail. |
| AC10 | **pass** | `node server.js` serves the project on `http://127.0.0.1:<port>`; `/` → 200 `text/html`, `/sketch.js` and `/pinch.js` → 200 `text/javascript`, and the files the page references exist. |

Not yet done: `git init` and the first commit (step 1 above), still awaiting an explicit go-ahead.

### L5 — User-reported defect (2026-10-15), verbatim

> siento que la pelota aveces se activas sola cuando no hay el movimiento de pinch puedes mejorar eso porfa

Interpreted as: the ball changes size on its own, without a pinch being performed.

### L6 — Root cause, fix and evidence (2026-10-15)

Requirements S8 (rewritten), S9 and S10 were added; AC11 and AC12 were added. No other `S#` changed.

**The defect was reproduced and quantified before any code changed**, by driving the existing module with
synthetic landmarks:

| Scenario | Observed on the old code |
| --- | --- |
| One garbage frame (phantom / collapsed landmarks) | ratio `50` -> `clamp` -> diameter `420 px`, i.e. **maximum size**; as a first detection the ball appeared directly at maximum |
| A distant or edge hand (palm `10 px`), 3 px of detector jitter | moved the ball `88.9 px`, **22% of its whole range** |
| Three garbage frames in a row | dragged the ball from `200 px` to `298.7 px` — smoothing follows a bad frame, it does not reject it |

Three separate causes, all in the ungated path where `hands[0]` was fed straight into the mapping:

1. **No plausibility rejection.** Any ratio above `maxRatio` was clamped, and clamping maps garbage to
   "fully open", which *is* the maximum diameter. Garbage became maximum size.
2. **No minimum palm scale.** `handScale` only rejected exactly zero, so a small projected palm made the
   ratio hypersensitive to jitter.
3. **No warm-up.** A single frame was enough to move the ball, including the very first-appearance snap.

A fourth, subtler cause was also addressed: the palm scale was read from a **single** segment, so rotating
the hand foreshortened it in the 2D projection and the ball moved with no pinch at all. `handScale` now takes
the **longest** of three rigid palm segments, which reduces but does not eliminate the effect. This residual
limit is documented as a risk rather than claimed as fixed, and the proper fix (3D palm from `keypoints3D`)
is recorded with its cost in the README.

**Structural change:** the per-frame decision moved out of the render loop into a pure reducer,
`stepTracking(state, hand, config)`, in `pinch.js`. The bug lived in the wiring (`updateDiameter` in
`sketch.js`), which was not testable in place. Now it is: the tests feed frame *sequences* and assert what
the ball does.

**Verification:**

- `node --test` -> **58 tests, 58 pass, 0 fail** (`pinch.test.js` grew from 28 to 44).
- Before/after on the same scenarios: garbage frame -> `accepted=false reason=implausible`, ball not drawn;
  60 alternating good/garbage frames -> ball never appears; tiny hand -> `reason=hand-too-small`, size held;
  a real pinch still reaches `20 px` and `420 px` and returns.
- End-to-end: the page, `sketch.js` and `pinch.js` all serve over HTTP with the correct content types, and
  `sketch.js` no longer contains an ungated path from `hands[0]` into the mapping.

`AC11` and `AC12` are covered by `pinch.test.js`. The gate thresholds are still estimates to confirm with a
real webcam, so `AC2`–`AC8` remain pending from L4, now joined by confirmation that the gates do not fire
falsely on a real hand.
