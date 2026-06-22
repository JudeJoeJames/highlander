import type { PerspectiveCamera } from "three";
import { Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SeatFrame } from "./layout";

const COOLDOWN_MS = 6000; // after a manual move, suppress auto-focus this long
const LERP = 0.06; // per-frame easing toward the focus target

/**
 * Wraps OrbitControls and adds "focus on the active player" with a manual
 * override: the moment the user pans/zooms/rotates, auto-focus is suppressed
 * until COOLDOWN_MS after they stop. This satisfies the design rule that the
 * app may reframe the table, but never yanks the camera out from under a
 * player who is actively looking around.
 */
export class CameraController {
  readonly controls: OrbitControls;
  private desiredPos: Vector3 | null = null;
  private desiredTarget: Vector3 | null = null;
  private lastUserInteract = -Infinity;
  private dragging = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    domElement: HTMLElement,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.49; // stay above the table
    this.controls.minDistance = 4;
    this.controls.maxDistance = 26;

    this.controls.addEventListener("start", () => {
      this.dragging = true;
      this.lastUserInteract = this.now();
    });
    this.controls.addEventListener("end", () => {
      this.dragging = false;
      this.lastUserInteract = this.now();
    });
  }

  /** Request the camera to frame a seat. Honored once the cooldown elapses. */
  focusSeat(frame: SeatFrame): void {
    // Sit behind the seat, looking across its battlefield toward the center.
    const target = frame.pos.clone().addScaledVector(frame.toCenter, 2.4);
    target.y = 0;
    const pos = frame.pos
      .clone()
      .addScaledVector(frame.toCenter, -3.2) // behind the player
      .add(new Vector3(0, 8.5, 0));
    this.desiredPos = pos;
    this.desiredTarget = target;
  }

  private autoAllowed(): boolean {
    return !this.dragging && this.now() - this.lastUserInteract > COOLDOWN_MS;
  }

  /** Call every frame. Eases toward the focus target when permitted. */
  update(): void {
    if (this.desiredPos && this.desiredTarget && this.autoAllowed()) {
      this.camera.position.lerp(this.desiredPos, LERP);
      this.controls.target.lerp(this.desiredTarget, LERP);
      if (this.camera.position.distanceToSquared(this.desiredPos) < 0.0025) {
        this.desiredPos = null;
        this.desiredTarget = null;
      }
    }
    this.controls.update();
  }
}
