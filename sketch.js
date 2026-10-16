/**
 * Pinch to Size — p5.js sketch + ml5 hand tracking (spec S1, S2, S5, S7, S8).
 *
 * This file owns everything that touches the browser: the camera, the model,
 * the drawing and the DOM status line. All the gesture math lives in pinch.js
 * so that it stays testable without a browser.
 */

import {
  PINCH_DEFAULTS,
  REJECTION,
  findLandmark,
  initialTrackingState,
  keypointsOf,
  stepTracking,
} from "./pinch.js";

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 480;

const statusElement = document.getElementById("status");
const canvasHolder = document.getElementById("canvas-holder");

let capture = null;
let handPose = null;
let hands = null;

/**
 * Tracking state owned by the pure reducer in pinch.js: the current diameter
 * and the number of consecutive acceptable frames.
 */
let trackingState = initialTrackingState();

/** The last frame's verdict, kept for the debug overlay and the status line. */
let measurement = null;

let showDebug = false;

/** Last status string written, so the DOM is not touched on every frame. */
let reportedStatus = null;

// ---------------------------------------------------------------------------
// Status line (spec S7)
// ---------------------------------------------------------------------------

function setStatus(message, variant = "info") {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.dataset.variant = variant;
}

function failStatus(message) {
  console.error(message);
  setStatus(message, "error");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The rectangle the camera image occupies inside the canvas, letterboxed so the
 * video keeps its aspect ratio (spec S1).
 */
function videoRect(s) {
  const videoWidth = capture?.elt?.videoWidth || CANVAS_WIDTH;
  const videoHeight = capture?.elt?.videoHeight || CANVAS_HEIGHT;
  const scale = Math.min(s.width / videoWidth, s.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;

  return {
    x: (s.width - width) / 2,
    y: (s.height - height) / 2,
    width,
    height,
    scale,
  };
}

/**
 * Map a video-space keypoint onto the canvas, applying the same horizontal
 * mirror used to draw the video, so landmarks stay glued to the image.
 */
function toCanvasPoint(keypoint, rect) {
  return {
    x: rect.x + rect.width - keypoint.x * rect.scale,
    y: rect.y + keypoint.y * rect.scale,
  };
}

// ---------------------------------------------------------------------------
// Camera and model setup
// ---------------------------------------------------------------------------

/**
 * Ask for the camera *before* p5 creates its capture element, so a refusal has
 * a name we can explain. The stream is stopped immediately; this call exists to
 * surface the error, and the granted permission makes p5's request silent.
 */
async function requestCameraAccess() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error("secure context required");
    error.name = "InsecureContextError";
    throw error;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  for (const track of stream.getTracks()) track.stop();
}

function describeCameraError(error) {
  switch (error?.name) {
    case "InsecureContextError":
      return "The camera needs a secure context. Open this page over http://localhost (or http://127.0.0.1) instead of file://.";
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was denied. Allow camera access for this page and reload.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No usable camera was found on this device.";
    case "NotReadableError":
      return "The camera is already in use by another application.";
    case "AbortError":
      return "The camera start was aborted. Reload the page and try again.";
    default:
      return `The camera could not be started: ${error?.message ?? error}`;
  }
}

/**
 * Wrap ml5's callback-style model loader in a promise.
 *
 * The callback receives `(model, error)`. Some builds also return the instance
 * synchronously from the constructor, so fall back to that when the callback
 * arrives without arguments.
 */
async function loadHandPose() {
  const instance = await new Promise((resolve, reject) => {
    let fromConstructor = null;

    fromConstructor = ml5.handPose({ maxHands: 1 }, (model, error) => {
      if (error) {
        reject(new Error(error.message ?? String(error)));
        return;
      }
      resolve(model ?? fromConstructor);
    });
  });

  if (!modelIsUsable(instance)) {
    throw new Error("ml5.handPose() did not return a usable model");
  }

  return instance;
}

function modelIsUsable(model) {
  return Boolean(model) && typeof model.detectStart === "function";
}

const sketch = (s) => {
  s.setup = async () => {
    s.createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT).parent(canvasHolder);
    s.rectMode(s.CORNER);

    if (typeof ml5 === "undefined") {
      failStatus("ml5.js did not load from the CDN. Check your connection and reload.");
      return;
    }

    setStatus("Requesting camera access…");
    try {
      await requestCameraAccess();
    } catch (error) {
      failStatus(describeCameraError(error));
      return;
    }

    try {
      capture = s.createCapture(s.VIDEO);
      capture.size(CANVAS_WIDTH, CANVAS_HEIGHT);
      capture.hide();
    } catch (error) {
      failStatus(describeCameraError(error));
      return;
    }

    setStatus("Loading the hand model — this downloads model weights once…");
    try {
      handPose = await loadHandPose();
    } catch (error) {
      failStatus(`The hand model failed to load: ${error.message ?? error}`);
      return;
    }

    handPose.detectStart(capture, (results) => {
      hands = results;
    });

    setStatus("Camera ready — show your hand to the camera.");
  };

  s.draw = () => {
    s.background(13, 16, 23);

    // Before the first frame arrives there is nothing to draw; the DOM status
    // line stays visible on top of the empty canvas.
    if (!capture?.elt || capture.elt.readyState < 2) return;

    const rect = videoRect(s);
    drawMirroredVideo(s, rect);
    advanceTracking();
    drawBall(s);
    reportStatus();

    if (showDebug) drawDebug(s, rect);
  };

  s.keyPressed = () => {
    if (s.key === "d" || s.key === "D") {
      showDebug = !showDebug;
      return false;
    }
    return true;
  };
};

function drawMirroredVideo(s, rect) {
  s.push();
  s.translate(rect.x + rect.width, rect.y);
  s.scale(-1, 1);
  s.image(capture, 0, 0, rect.width, rect.height);
  s.pop();
}

/**
 * Advance one frame through the pure reducer in pinch.js.
 *
 * Every acceptance gate lives there, not here: this function must not be the
 * place where an ungated detection sneaks into the ball size. That was exactly
 * the bug — `hands[0]` was fed straight into the mapping, so a garbage frame
 * clamped to "fully open" and the ball jumped to maximum size on its own.
 */
function advanceTracking() {
  trackingState = stepTracking(trackingState, hands?.[0]);
  measurement = trackingState.measurement;
}

/** Explain what the app is doing, so a paused ball is never a mystery. */
function statusMessageFor(state) {
  if (state.tracking) return "Tracking — pinch to resize the ball.";

  switch (state.measurement?.reason) {
    case REJECTION.noHand:
      return state.diameter === null
        ? "No hand detected — show your hand to the camera."
        : "No hand detected — holding the last size.";
    case REJECTION.handTooSmall:
      return "Hand too far from the camera — move closer for a stable reading.";
    case REJECTION.implausible:
      return "Unreliable reading ignored — holding the last size.";
    case REJECTION.lowConfidence:
      return "Weak detection — hold your hand steadier.";
    case REJECTION.unmeasurable:
      return "Move your whole hand into view.";
    default:
      return "Hold steady…";
  }
}

function reportStatus() {
  const message = statusMessageFor(trackingState);
  if (message === reportedStatus) return;
  reportedStatus = message;
  setStatus(message, trackingState.tracking ? "info" : "warn");
}

function drawBall(s) {
  const diameter = trackingState.diameter;
  if (diameter === null) return;

  const centerX = s.width / 2;
  const centerY = s.height / 2;

  s.noStroke();
  s.fill(90, 200, 255, 45);
  s.circle(centerX, centerY, diameter + 26);

  s.fill(96, 202, 255, 235);
  s.circle(centerX, centerY, diameter);

  s.fill(255, 255, 255, 150);
  s.circle(centerX - diameter * 0.16, centerY - diameter * 0.16, Math.max(diameter * 0.22, 3));
}

function drawDebug(s, rect) {
  const keypoints = measurement?.keypoints ?? null;

  if (keypoints) {
    const thumb = findLandmark(keypoints, "thumb_tip");
    const index = findLandmark(keypoints, "index_finger_tip");

    if (thumb && index) {
      const from = toCanvasPoint(thumb, rect);
      const to = toCanvasPoint(index, rect);
      s.stroke(255, 214, 92);
      s.strokeWeight(2);
      s.line(from.x, from.y, to.x, to.y);
    }

    s.noStroke();
    s.fill(255, 96, 128);
    for (const keypoint of keypoints) {
      const point = toCanvasPoint(keypoint, rect);
      s.circle(point.x, point.y, 7);
    }
  }

  const ratio = measurement?.ratio;
  const palmScale = measurement?.palmScale;
  const gate = measurement?.accepted ? "ok" : (measurement?.reason ?? "—");

  s.noStroke();
  s.fill(6, 9, 14, 200);
  s.rect(12, 12, 286, 118, 8);

  s.fill(230, 238, 248);
  s.textSize(13);
  s.textAlign(s.LEFT, s.TOP);
  s.text(`ratio      ${ratio == null ? "—" : ratio.toFixed(3)}`, 24, 20);
  s.text(`palm       ${palmScale == null ? "—" : `${Math.round(palmScale)} px`}`, 24, 38);
  s.text(`gate       ${gate}`, 24, 56);
  s.text(`stable     ${trackingState.stableFrames}/${PINCH_DEFAULTS.warmupFrames}`, 24, 74);
  s.text(`diameter   ${Math.round(trackingState.diameter ?? 0)} px`, 24, 92);
  s.text(
    `min palm   ${PINCH_DEFAULTS.minPalmScale} px · max ratio ${PINCH_DEFAULTS.maxPlausibleRatio}`,
    24,
    110,
  );
}

new p5(sketch);
