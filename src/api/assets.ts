// /api/assets — asset pipeline helpers for the editor.
//
// POST /api/assets/import-scene
//   Reads a GLB and returns a SceneDocument (or single GltfRef entity) for the
//   editor to merge into scene.json.
//
// glТF → .meta.json cooking is NOT done here. The backend (platform-io is the
// 6-layer model's backend L1) cannot import @forgeax/engine-gltf (frontend L1),
// so a backend-side cook can only hand-roll the sidecar — a second, drifting
// implementation of the engine's toAssetPack. The editor (frontend L2) cooks
// the canonical `external-asset-package` sidecar via engine-gltf's
// parseGlb/toAssetPack SSOT instead (editor-core `cookGltfMeta`), then writes it
// through /api/files. The former POST /api/assets/process-gltf endpoint was that
// hand-rolled second implementation and has been removed.
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultProjectRoot, resolveSafePath } from './lib/safe-path';

export function createAssetsRouter(): Hono {
  const r = new Hono();

  // POST /api/assets/import-scene
  // Body: { path: string, mode?: 'reference'|'full', maxNodes?: number }
  // Reads a GLB and returns a SceneDocument (or patch) to merge into scene.json.
  //   'reference' (default): ONE entity with GltfRef + Transform → fastest, best for
  //      large scenes (>200 nodes). Engine renders via loadByGuid on the scene GUID.
  //   'full': one SceneDocument entity per GLTF node → shows full hierarchy in the
  //      editor tree; only recommended for small scenes (≤200 nodes).
  r.post('/import-scene', async (c) => {
    let body: { path?: unknown; mode?: unknown; maxNodes?: unknown };
    try { body = await c.req.json() as typeof body; }
    catch { return c.json({ error: 'invalid json body' }, 400); }
    if (typeof body?.path !== 'string') return c.json({ error: 'path required' }, 400);
    const root = defaultProjectRoot();
    const abs = resolveSafePath(root, body.path);
    if (!abs) return c.json({ error: 'path outside whitelist' }, 400);
    if (!/\.(glb|gltf)$/i.test(body.path)) return c.json({ error: 'only .glb/.gltf' }, 400);

    let bytes: Buffer;
    try { bytes = await readFile(abs); } catch { return c.json({ error: 'file not found' }, 404); }

    // Parse GLB JSON chunk directly (no engine dep needed for the node walk).
    let gltfJson: {
      nodes?: Array<{ name?: string; translation?: number[]; rotation?: number[]; scale?: number[]; mesh?: number; children?: number[] }>;
      meshes?: Array<{ name?: string }>;
      materials?: Array<{ name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
      scenes?: Array<{ nodes?: number[] }>;
      scene?: number;
    };
    try {
      const isGlb = bytes.readUInt32BE(0) === 0x676C5446; // 'glTF'
      if (isGlb) {
        const jsonLen = bytes.readUInt32LE(12);
        gltfJson = JSON.parse(bytes.slice(20, 20 + jsonLen).toString('utf8'));
      } else {
        gltfJson = JSON.parse(bytes.toString('utf8'));
      }
    } catch (e) { return c.json({ error: `parse failed: ${(e as Error).message}` }, 422); }

    const nodes = gltfJson.nodes ?? [];
    const meshes = gltfJson.meshes ?? [];
    const materials = gltfJson.materials ?? [];
    const sceneRootNodes = (gltfJson.scenes ?? [])[gltfJson.scene ?? 0]?.nodes ?? [];
    const totalNodes = nodes.length;
    const mode = (typeof body.mode === 'string' ? body.mode : 'auto') as string;
    const maxNodes = typeof body.maxNodes === 'number' ? body.maxNodes : 200;

    // 'auto': pick 'reference' for large scenes, 'full' for small ones.
    const effectiveMode = mode === 'auto'
      ? (totalNodes > maxNodes ? 'reference' : 'full')
      : mode;

    const fileName = resolve(abs).split('/').pop() ?? 'model';
    const modelName = fileName.replace(/\.(glb|gltf)$/i, '');

    if (effectiveMode === 'reference') {
      // Single entity pointing to the whole GLB. Fast, works for any size.
      const entity = {
        id: 1, name: modelName, parent: null,
        components: {
          Transform: { x: 0, y: 0, z: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
          GltfRef: { path: body.path, nodeCount: totalNodes, meshCount: meshes.length },
        },
      };
      return c.json({
        mode: 'reference', totalNodes, meshCount: meshes.length,
        entity, // caller merges into scene
        warning: totalNodes > maxNodes
          ? `Large scene (${totalNodes} nodes) — imported as single GltfRef entity. Use mode:"full" for individual entities.`
          : undefined,
      });
    }

    // 'full' mode: convert every GLTF node to a SceneDocument entity.
    // Quaternion → Euler (YXZ, degrees) for the editor's rotX/Y/Z fields.
    function quatToEuler(q: number[]): { rotX: number; rotY: number; rotZ: number } {
      const [qx = 0, qy = 0, qz = 0, qw = 1] = q;
      const sinr_cosp = 2 * (qw * qx + qy * qz);
      const cosr_cosp = 1 - 2 * (qx * qx + qy * qy);
      const rx = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);
      const sinp = 2 * (qw * qy - qz * qx);
      const ry = Math.abs(sinp) >= 1 ? Math.sign(sinp) * 90 : Math.asin(sinp) * (180 / Math.PI);
      const siny_cosp = 2 * (qw * qz + qx * qy);
      const cosy_cosp = 1 - 2 * (qy * qy + qz * qz);
      const rz = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);
      const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
      return { rotX: r4(rx), rotY: r4(ry), rotZ: r4(rz) };
    }

    let nextId = 1;
    const entitiesArr: Array<{ id: number; name: string; parent: number | null; components: Record<string, unknown> }> = [];

    function walkNode(nodeIdx: number, parentId: number | null): void {
      const n = nodes[nodeIdx];
      if (!n) return;
      const id = nextId++;
      const [tx = 0, ty = 0, tz = 0] = n.translation ?? [];
      const [sx = 1, sy = 1, sz = 1] = n.scale ?? [];
      const rot = n.rotation ? quatToEuler(n.rotation) : {};
      const transform = { x: tx, y: ty, z: tz, scaleX: sx, scaleY: sy, scaleZ: sz, ...rot };
      const components: Record<string, unknown> = { Transform: transform };

      if (n.mesh !== undefined) {
        const m = meshes[n.mesh];
        const mat = materials[0]; // simplification: first material
        components.Mesh = { kind: 'cube' }; // placeholder — real geometry via GUID later
        if (mat?.pbrMetallicRoughness?.baseColorFactor) {
          const [r = 0.8, g = 0.8, b = 0.8] = mat.pbrMetallicRoughness.baseColorFactor;
          const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
          components.Material = { albedo: `#${h(r)}${h(g)}${h(b)}` };
        }
      }
      entitiesArr.push({ id, name: n.name ?? `Node_${nodeIdx}`, parent: parentId, components });
      (n.children ?? []).forEach((ci) => walkNode(ci, id));
    }

    sceneRootNodes.forEach((ri) => walkNode(ri, null));

    const entitiesMap: Record<number, typeof entitiesArr[number]> = {};
    entitiesArr.forEach((e) => { entitiesMap[e.id] = e; });

    return c.json({
      mode: 'full', totalNodes: entitiesArr.length, meshCount: meshes.length,
      doc: {
        version: '1',
        nextId: nextId,
        entities: entitiesMap,
        order: entitiesArr.map((e) => e.id),
      },
    });
  });

  return r;
}
