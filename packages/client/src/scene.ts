import {
  AmbientLight,
  CircleGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { TABLE_RADIUS } from "./layout";

export interface SceneRefs {
  renderer: WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  resize: () => void;
}

/** Build the renderer, lights, camera, and the table surface. */
export function createScene(canvas: HTMLCanvasElement, labelHost: HTMLElement): SceneRefs {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const labelRenderer = new CSS2DRenderer({ element: labelHost });

  const scene = new Scene();
  scene.background = new Color("#0e1116");

  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 16, 0.02); // start top-down
  camera.lookAt(0, 0, 0);

  scene.add(new AmbientLight(0xffffff, 0.85));
  const sun = new DirectionalLight(0xffffff, 1.1);
  sun.position.set(4, 12, 6);
  scene.add(sun);

  const table = new Mesh(
    new CircleGeometry(TABLE_RADIUS + 1.5, 64),
    new MeshStandardMaterial({ color: "#243140", roughness: 0.95 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.02;
  scene.add(table);

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  return { renderer, labelRenderer, scene, camera, resize };
}
