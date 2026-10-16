# Pinch to Size

Control the size of a ball with a pinch gesture, tracked through your webcam.

Pinching your thumb and index finger together shrinks the ball; opening your hand grows it.

- **p5.js 2.3.4** and **ml5.js 1.4.0**, both from a CDN. No build step, no bundler, no `npm install`.

The specification this project was built against is in [`specs/hand-pinch-ball.md`](specs/hand-pinch-ball.md).

## Requirements

| | |
| --- | --- |
| Node | Any version with ESM + `node --test` (tested on v24.22.0). Used only for the local server and the math tests. |
| Browser | Chrome, Edge or Firefox, with a webcam. |
| Network | Needed at page load, and again at runtime: ml5 downloads the hand model weights on first use. |

## Run it

```powershell
node server.js
```

Then open **http://127.0.0.1:4173**.

Use a different port with `$env:PORT=5000; node server.js`.

> **Why a local server instead of just opening `index.html`?**
> `getUserMedia()` only works in a *secure context*. `http://localhost` and `http://127.0.0.1` are secure
> contexts; `file://` is not. Opening the HTML file directly will fail to get the camera, and the app will
> tell you so.

## Controls

| Input | Effect |
| --- | --- |
| Pinch thumb + index together | Ball shrinks to its minimum |
| Open the hand | Ball grows to its maximum |
| <kbd>d</kbd> | Toggle the debug overlay (landmarks, live ratio, current diameter) |

## How the gesture is measured

The raw pixel distance between the thumb tip and the index tip is **not** used directly, because the same
gesture would then mean different things depending on how far you stand from the camera. Instead:

```
scale  = longest palm segment visible                  // how big the palm looks on screen
ratio  = distance(thumb_tip, index_finger_tip) / scale
```

The palm segments are `wrist→middle_finger_mcp`, `wrist→index_finger_mcp` and
`index_finger_mcp→pinky_mcp`. All three belong to the rigid palm, so none of them moves while you pinch.
Taking the **longest** one matters: the palm is measured in the 2D projection, so rotating your hand
foreshortens those segments — but never all by the same amount. Measuring a single segment makes the ball
change size when you merely turn your hand.

The ratio is therefore dimensionless and the gesture behaves the same at 40 cm and at 120 cm.

## Signal acceptance: why the ball pauses instead of jumping

A webcam hand detector does not only return clean hands. It also emits phantom hands at the edge of the
frame, collapsed landmark sets, and hands so small that the ratio is mostly noise. Feeding those straight
into the mapping is what makes a ball change size on its own, because **clamping turns an absurd ratio into
"fully open", and therefore into the maximum size**.

So every frame has to pass gates before it is allowed to move the ball. A gate can only *reject* a frame, and
a rejected frame holds the last size:

| Gate | Rejects when | Symptom it removes |
| --- | --- | --- |
| `minPalmScale` | the palm looks smaller than 30 px | a distant or edge hand swinging the ball wildly |
| `maxPlausibleRatio` | the ratio exceeds 2.5 | a phantom frame snapping the ball to maximum size |
| `minConfidence` | the detector reports low confidence (checked only when it reports one at all) | weak detections |
| `warmupFrames` | fewer than 3 *consecutive* acceptable frames | one bad frame making the ball appear or twitch |

Any rejection resets the warm-up counter, so the ball pauses on a bad frame instead of following it. The
status line names the gate that is holding the ball, and the debug overlay (<kbd>d</kbd>) shows the live
ratio, the palm size in pixels, the gate verdict and the warm-up counter.

## Calibration

The two ratios in `pinch.js` are estimates, not measurements of your hand:

```js
export const PINCH_DEFAULTS = Object.freeze({
  minRatio: 0.25,          // ratio with thumb and index touching
  maxRatio: 1.6,           // ratio with the hand fully open
  minDiameter: 20,         // px
  maxDiameter: 420,        // px
  smoothing: 0.18,         // lerp factor per frame
  minPalmScale: 30,        // px — reject smaller palms
  maxPlausibleRatio: 2.5,  // reject larger ratios
  warmupFrames: 3,         // consecutive frames before the ball responds
  minConfidence: 0.5,      // applied only when the detector reports one
});
```

To tune the gesture:

1. Run the app and press <kbd>d</kbd>.
2. Touch your thumb and index together and read `ratio`. Put that value in `minRatio`.
3. Open your hand fully and read `ratio` again. Put that value in `maxRatio`.
4. Reload.

If the ball feels laggy, raise `smoothing` toward `0.3`. If it vibrates, lower it toward `0.1`.

If the status line keeps saying the hand is too far, lower `minPalmScale` — but the noise it protects you
from comes back proportionally. The debug overlay shows the live palm size so you can pick a value that
matches how you actually sit.

## Tests

```powershell
node --test
```

58 tests, in three groups:

- **`pinch.test.js` (44)** — the gesture math and the entire per-frame decision: landmark resolution,
  palm-scale normalisation and its rotation tolerance, distance invariance, clamping, monotonicity of the
  ratio-to-diameter mapping, smoothing convergence, every acceptance gate, the warm-up, and the "hold the
  last size" rule. The frame reducer is tested by feeding it synthetic *sequences* and asserting what the
  ball does, which is how the false-activation cases stay pinned.
- **`server.test.js` (8)** — the static server: content types (a `.js` file must be served as JavaScript or
  the ES module will not evaluate), nested files, 404s and the request-level traversal guard.
- **`server.guard.test.js` (6)** — the filesystem access boundary: symlink/junction escapes, malformed
  targets, sibling directories sharing the root's name prefix, and the "importing must not start a
  listener" invariant.

`pinch.js` has no dependency on p5, ml5 or the DOM precisely so its tests need no browser.

**What the tests cannot cover:** the camera, the model, and the rendering. Those are the manual items in the
spec (`AC2`–`AC8`) and need a real webcam and a real hand.

## Troubleshooting

**"The camera needs a secure context."**
You opened the file directly. Serve it with `node server.js` and use the `http://127.0.0.1` URL.

**The status line stays on "No hand detected" while your hand is clearly in frame.**
Open the debug overlay with <kbd>d</kbd>. If no red landmarks appear, the model is not seeing the hand — check
that the browser console has no network errors, since the model weights are downloaded at runtime and an
ad-blocker or a restrictive network can block them.

If the console reports an error about `keypoints`, the installed ml5 build may expose landmarks under a
different property name. `keypointsOf()` in `sketch.js` already accepts both `hand.keypoints` and
`hand.landmarks`; add the name your build uses there.

**"ml5.js did not load from the CDN."**
The CDN was unreachable. Check your connection and reload. All three of jsDelivr, unpkg and cdnjs serve these
versions if you need to switch: replace the `<script src>` value in `index.html`.

**The ball jumps around instead of moving smoothly.**
Recalibrate `minRatio` / `maxRatio` (see above). A `maxRatio` that is too low makes small finger movements
saturate the range.

**The ball pauses and the status line says the reading was ignored.**
That is the acceptance gate doing its job: the frame looked like a phantom hand, a collapsed landmark set or
a hand too small to measure. It is holding the last size rather than following a bad reading. If it happens
often, press <kbd>d</kbd> and watch `palm` and `gate`: a `hand-too-small` verdict that fires while your hand
is comfortably in view means `minPalmScale` is too high for how you sit.

**The ball changes size when I rotate or move my hand without pinching.**
This is the residual limit of the metric. The palm is measured in the 2D image, so any rotation still
foreshortens it to some degree; the multi-segment estimate only reduces the effect. The proper fix is
measuring the palm in 3D from `keypoints3D`, which costs noise because the detector's `z` is less reliable
than its `x` and `y`.

## Project layout

```
index.html                 page shell, pinned CDN scripts, status overlay
sketch.js                  camera, ml5 hand pose, drawing (browser-side)
pinch.js                   pure gesture math — no p5, no ml5, no DOM
pinch.test.js              unit tests for pinch.js
server.js                  zero-dependency static server
server.test.js             endpoint and content-type tests
server.guard.test.js       filesystem access boundary tests
specs/hand-pinch-ball.md   the specification
```

## Not included

Two hands at once, depth/`z` landmark use, recording, a mobile-specific layout, any build tooling, and
persisted calibration. See the spec's "Out of scope" section for the reasoning.
