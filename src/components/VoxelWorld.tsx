import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { WorldSnapshot } from '@/sim/world';
import { heatColor } from '@/components/Heatmap';
import {
  buildObjects,
  buildTerrain,
  buildVillager,
  groundHeight,
  ISLAND_TOP,
  makeBubble,
  type VillagerRig,
} from '@/components/voxel/builders';

const CENTER = 12;

export function VoxelWorld({
  snapshot,
  sayEvent,
  focusAgentId,
  bubblesOn,
  heatmap,
}: {
  snapshot: WorldSnapshot;
  sayEvent?: { id: string; agentId: string; message: string } | null;
  focusAgentId?: string | null;
  bubblesOn?: boolean;
  heatmap?: Array<{ x: number; y: number; intensity: number }> | null;
}) {
  const heatmapRef = useRef(heatmap);
  heatmapRef.current = heatmap;
  const mountRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const rigsRef = useRef<Map<string, VillagerRig>>(new Map());
  const focusRef = useRef({ x: CENTER, y: ISLAND_TOP + 1, z: CENTER, dist: 34 });
  const bubblesOnRef = useRef(bubblesOn);
  bubblesOnRef.current = bubblesOn;

  // hotbar focus: tween the camera toward the selected villager
  useEffect(() => {
    if (!focusAgentId) return;
    const started = performance.now();
    const start = { ...focusRef.current };
    let raf = 0;
    const step = () => {
      const rig = rigsRef.current.get(focusAgentId);
      if (!rig) return;
      const p = Math.min(1, (performance.now() - started) / 600);
      const e = 1 - Math.pow(1 - p, 3);
      focusRef.current.x = start.x + (rig.group.position.x - start.x) * e;
      focusRef.current.z = start.z + (rig.group.position.z - start.z) * e;
      focusRef.current.y = start.y + (ISLAND_TOP + 1 - start.y) * e;
      focusRef.current.dist = start.dist + (14 - start.dist) * e;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [focusAgentId]);

  useEffect(() => {
    if (!sayEvent) return;
    const rigs = rigsRef.current;
    const rig = rigs.get(sayEvent.agentId);
    if (!rig) return;
    const sprite = makeBubble(sayEvent.message, '#e8dcc0', 'speech');
    sprite.position.y = 1.75;
    rig.group.add(sprite);
    const timer = setTimeout(() => {
      rig.group.remove(sprite);
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }, 6000);
    return () => {
      clearTimeout(timer);
      rig.group.remove(sprite);
      sprite.material.map?.dispose();
      sprite.material.dispose();
    };
  }, [sayEvent]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0e1e30');
    scene.fog = new THREE.Fog('#0e1e30', 30, 70);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 200);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      });
    } catch (err) {
      console.error('WebGL init failed', err);
      mount.innerHTML =
        '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#d6c9a8;font-family:serif">3D view needs WebGL, which this browser or device has disabled. The simulation still runs below.</div>';
      return;
    }
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // lighting: warm sun + cool fill + ambient
    const sun = new THREE.DirectionalLight('#fff3d6', 1.4);
    sun.position.set(20, 30, 10);
    scene.add(sun);
    const fill = new THREE.DirectionalLight('#7ab3d4', 0.35);
    fill.position.set(-15, 12, -20);
    scene.add(fill);
    scene.add(new THREE.AmbientLight('#4a5a6e', 0.85));

    // terrain + initial objects
    scene.add(buildTerrain());
    let objectsGroup = buildObjects(snapshotRef.current.objects);
    scene.add(objectsGroup);

    // heatmap overlay: translucent planes over the island tiles
    let heatGroup: THREE.Group | null = null;
    let lastHeatKey = '';
    function syncHeatmap() {
      const tiles = heatmapRef.current;
      const key = tiles && tiles.length > 0 ? JSON.stringify(tiles) : '';
      if (key === lastHeatKey) return;
      lastHeatKey = key;
      if (heatGroup) {
        scene.remove(heatGroup);
        heatGroup.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.MeshBasicMaterial).dispose();
          }
        });
        heatGroup = null;
      }
      if (!tiles || tiles.length === 0) return;
      heatGroup = new THREE.Group();
      const geo = new THREE.PlaneGeometry(0.95, 0.95);
      for (const t of tiles) {
        if (t.intensity < 0.08) continue;
        const mat = new THREE.MeshBasicMaterial({
          color: heatColor(t.intensity),
          transparent: true,
          opacity: 0.15 + t.intensity * 0.5,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(t.x + 0.5, groundHeight(t.x, t.y) + 0.06, t.y + 0.5);
        heatGroup.add(mesh);
      }
      scene.add(heatGroup);
    }

    // villagers
    const rigs = new Map<string, VillagerRig>();
    const bubbles = new Map<string, { sprite: THREE.Sprite; until: number }>();
    const thinkingMarker: Map<string, THREE.Sprite> = new Map();
    function showBubble(id: string, text: string, color: string, kind: 'speech' | 'thought') {
      const rig = rigs.get(id);
      if (!rig) return;
      const old = bubbles.get(id);
      if (old) {
        rig.group.remove(old.sprite);
        old.sprite.material.map?.dispose();
        old.sprite.material.dispose();
      }
      const sprite = makeBubble(text, color, kind);
      sprite.position.y = 1.75;
      rig.group.add(sprite);
      bubbles.set(id, { sprite, until: elapsed + 6 });
    }
    function setThinking(id: string, on: boolean, color: string) {
      const rig = rigs.get(id);
      if (!rig) return;
      const existing = thinkingMarker.get(id);
      if (on && !existing) {
        const sprite = makeBubble('thinking…', color, 'thought');
        sprite.position.y = 1.75;
        rig.group.add(sprite);
        thinkingMarker.set(id, sprite);
      } else if (!on && existing) {
        rig.group.remove(existing);
        existing.material.map?.dispose();
        existing.material.dispose();
        thinkingMarker.delete(id);
      }
    }
    function syncAgents() {
      const agents = snapshotRef.current.agents;
      const seen = new Set<string>();
      for (const a of agents) {
        seen.add(a.id);
        if (!rigs.has(a.id)) {
          const gy = groundHeight(a.pos.x, a.pos.y);
          const rig = buildVillager(a.name, a.color);
          rig.group.position.set(a.pos.x + 0.5, gy, a.pos.y + 0.5);
          rig.target.set(rig.group.position.x, gy, rig.group.position.z);
          rigs.set(a.id, rig);
          rigsRef.current = rigs;
          scene.add(rig.group);
        }
        const rig = rigs.get(a.id)!;
        rig.target.set(a.pos.x + 0.5, groundHeight(a.pos.x, a.pos.y), a.pos.y + 0.5);
      }
      for (const [id, rig] of rigs) {
        if (!seen.has(id)) {
          scene.remove(rig.group);
          rigs.delete(id);
        }
      }
    }
    syncAgents();

    // orbit camera: drag to rotate, scroll to zoom
    let angle = Math.PI * 0.25;
    let elevation = 0.9;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const el = renderer.domElement;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      if (pointers.size === 1) {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        el.style.cursor = 'grabbing';
      } else {
        dragging = false;
        const [p1, p2] = [...pointers.values()];
        pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const [p1, p2] = [...pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (pinchDist > 0) focusRef.current.dist = Math.min(55, Math.max(5, focusRef.current.dist - (d - pinchDist) * 0.06));
        pinchDist = d;
        return;
      }
      if (!dragging) return;
      angle -= (e.clientX - lastX) * 0.008;
      elevation = Math.min(1.45, Math.max(0.25, elevation + (e.clientY - lastY) * 0.006));
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 1) {
        const p = [...pointers.values()][0];
        dragging = true;
        lastX = p.x;
        lastY = p.y;
      } else if (pointers.size === 0) {
        dragging = false;
        el.style.cursor = 'grab';
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      focusRef.current.dist = Math.min(55, Math.max(5, focusRef.current.dist + e.deltaY * 0.02));
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });

    // animation loop
    let raf = 0;
    const clock = new THREE.Clock();
    const walkPhase = new Map<string, number>();
    let elapsed = 0;
    const births = new Map<string, number>(); // object id -> elapsed time when it appeared
    let growing: THREE.Mesh[] = [];

    function animate() {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      elapsed += dt;
      const t = elapsed;

      const f = focusRef.current;
      camera.position.set(
        f.x + f.dist * Math.cos(elevation) * Math.cos(angle),
        ISLAND_TOP + 1 + f.dist * Math.sin(elevation) + 4,
        f.z + f.dist * Math.sin(elevation) * Math.sin(angle)
      );
      camera.lookAt(f.x, f.y, f.z);

      // villagers: smooth walk to target + limb swing
      for (const [id, rig] of rigs) {
        const g = rig.group;
        const dx = rig.target.x - g.position.x;
        const dz = rig.target.z - g.position.z;
        const distance = Math.hypot(dx, dz);
        const speed = 3.2;
        if (distance > 0.02) {
          const step = Math.min(distance, speed * dt);
          g.position.x += (dx / distance) * step;
          g.position.z += (dz / distance) * step;
          g.position.y += (rig.target.y - g.position.y) * Math.min(1, dt * 8);
          g.rotation.y = Math.atan2(dx, dz);
          const phase = (walkPhase.get(id) ?? 0) + dt * 10;
          walkPhase.set(id, phase);
          const swing = Math.sin(phase) * 0.7;
          rig.leftLeg.rotation.x = swing;
          rig.rightLeg.rotation.x = -swing;
          rig.leftArm.rotation.x = -swing * 0.8;
          rig.rightArm.rotation.x = swing * 0.8;
          rig.body.position.y = 0.64 + Math.abs(Math.sin(phase)) * 0.02;
        } else {
          rig.leftLeg.rotation.x *= 0.8;
          rig.rightLeg.rotation.x *= 0.8;
          rig.leftArm.rotation.x *= 0.8;
          rig.rightArm.rotation.x *= 0.8;
          g.rotation.y += (Math.sin(t * 0.7 + id.length) * 0.4 - g.rotation.y) * 0.02;
          g.position.y += (rig.target.y - g.position.y) * Math.min(1, dt * 8);
        }
        // thinking bob + glow ring handled by label pulse
        if (snapshotRef.current.agents.find((a) => a.id === id)?.status === 'thinking') {
          rig.head.position.y = 0.86 + Math.sin(t * 6) * 0.03;
        } else {
          rig.head.position.y += (0.86 - rig.head.position.y) * 0.1;
        }
        // visible work: swing arms while acting
        if (snapshotRef.current.agents.find((a) => a.id === id)?.status === 'acting') {
          const work = Math.sin(t * 14) * 1.1;
          rig.leftArm.rotation.x = -0.6 - Math.abs(work) * 0.4;
          rig.rightArm.rotation.x = -0.6 - Math.abs(work);
          rig.body.rotation.z = Math.sin(t * 7) * 0.04;
        } else {
          rig.body.rotation.z *= 0.85;
        }
      }

      // animals breathe: a gentle bob and sway so the island feels inhabited
      objectsGroup.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.animal) {
          const oid = child.userData.oid as string;
          const phase = t * 2 + oid.length * 1.7;
          child.position.y = (child.userData.baseY as number) + Math.abs(Math.sin(phase)) * 0.06;
          child.rotation.y = Math.sin(t * 0.5 + oid.length) * 0.15;
        }
      });

      // grow-in animation for newly appeared objects
      growing = growing.filter((mesh) => {
        const born = births.get(mesh.userData.oid);
        if (born === undefined) return false;
        const age = elapsed - born;
        if (age >= 0.9) {
          mesh.scale.setScalar(1);
          return false;
        }
        const s = 0.01 + (age / 0.9) * (1 - 0.01) + Math.sin(age * 20) * 0.04;
        mesh.scale.setScalar(Math.min(1.06, Math.max(0.01, s)));
        return true;
      });

      // expire old bubbles
      for (const [id, b] of bubbles) {
        if (elapsed > b.until) {
          const rig = rigs.get(id);
          if (rig) rig.group.remove(b.sprite);
          b.sprite.material.map?.dispose();
          b.sprite.material.dispose();
          bubbles.delete(id);
        }
      }

      // gently rotate sun for a living world feel
      sun.position.set(
        CENTER + Math.cos(t * 0.05) * 26,
        30,
        CENTER + Math.sin(t * 0.05) * 26
      );

      renderer.render(scene, camera);
    }
    animate();

    // sync agents + objects + live mind activity each render
    let lastObjectsKey = '';
    const lastThoughts = new Map<string, string>();
    const lastBubbles = new Map<string, string>();
    const interval = setInterval(() => {
      syncAgents();
      syncHeatmap();
      const snap = snapshotRef.current;
      for (const a of snap.agents) {
        if (!bubblesOnRef.current) {
          setThinking(a.id, false, a.color);
          continue;
        }
        setThinking(a.id, a.status === 'thinking', a.color);
        if (a.lastThought && lastThoughts.get(a.id) !== a.lastThought) {
          lastThoughts.set(a.id, a.lastThought);
          showBubble(a.id, a.lastThought, a.color, 'thought');
        }
        // failures speak: the world explains itself instead of silently doing nothing
        if (a.lastBubble && lastBubbles.get(a.id) !== a.lastBubble) {
          lastBubbles.set(a.id, a.lastBubble);
          showBubble(a.id, a.lastBubble, '#f87171', 'thought');
        }
      }
      const key = JSON.stringify(snap.objects.map((o) => [o.id, o.kind, o.pos.x, o.pos.y]));
      if (key !== lastObjectsKey) {
        const oldIds = new Set<string>();
        objectsGroup.traverse((child) => {
          if (child instanceof THREE.Mesh && typeof child.userData.oid === 'string') oldIds.add(child.userData.oid);
        });
        for (const o of snap.objects) {
          if (!oldIds.has(o.id)) births.set(o.id, elapsed);
        }
        scene.remove(objectsGroup);
        objectsGroup.traverse((child) => {
          if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
            child.geometry?.dispose?.();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
              m?.map?.dispose?.();
              m?.dispose?.();
            });
          }
        });
        objectsGroup = buildObjects(snap.objects, births);
        scene.add(objectsGroup);
        growing = [];
        objectsGroup.traverse((child) => {
          if (child instanceof THREE.Mesh && births.has(child.userData.oid as string)) {
            const born = births.get(child.userData.oid as string)!;
            if (elapsed - born < 0.9) growing.push(child as THREE.Mesh);
          }
        });
        lastObjectsKey = key;
      }
    }, 400);

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
      window.removeEventListener('resize', onResize);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
          child.geometry?.dispose?.();
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((m) => {
            m?.map?.dispose?.();
            m?.dispose?.();
          });
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      if (el.parentNode === mount) mount.removeChild(el);
    };
  }, []);

  return <div ref={mountRef} className="h-[380px] w-full overflow-hidden rounded-2xl sm:h-[560px]" />;
}
