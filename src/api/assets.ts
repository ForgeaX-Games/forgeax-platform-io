// /api/assets — asset pipeline helpers for the editor.
//
// POST /api/assets/import-scene
//   Reads a GLB and returns scene metadata for the editor to materialise.
//
// glTF → .meta.json cooking is NOT done here. The backend (platform-io is the
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
  //   'reference' (default): returns scene metadata (path, nodeCount, meshCount)
  //      for the editor to materialise via engine-native instantiateScene (D-5).
  //      Fast, works for any size — no GltfRef entity wrapper.
  //   'full': one entity per GLTF node → shows full hierarchy in the editor tree;
  //      only recommended for small scenes (≤200 nodes).
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
      // M4 / D-5: return scene metadata for the editor to materialise via
      // engine-native instantiateScene (no GltfRef entity wrapper).
      return c.json({
        mode: 'reference', totalNodes, meshCount: meshes.length,
        path: body.path, name: modelName,
        warning: totalNodes > maxNodes
          ? `Large scene (${totalNodes} nodes) — imported as reference. Use mode:"full" for individual entities.`
          : undefined,
      });
    }

    // 'full' mode: convert every GLTF node to a SceneDocument entity using the
    // ENGINE-NATIVE component vocabulary.
    //
    // F-1 review round 1 (feat-20260701 collapse): the former 'full' branch
    // emitted editor-legacy components — `Transform{x,y,z,rotX/Y/Z}`,
    // `Mesh{kind:'cube'}`, `Material{albedo}` — which the collapse DELETED from
    // the editor schema/spawn. The editor's `spawnComponentData` resolves only
    // registered engine components and (previously) silently dropped the rest, so
    // every imported node materialised as an origin-placed empty Transform with
    // NO geometry: an AGENTS.md #2 data-loss regression (geometry vanishes on
    // import, never round-trips to reopen / Play). We now emit only components
    // the editor registers:
    //   - Transform: engine POD — pos[3], quat[4], scale[3] arrays (feat-20260709
    //     array-TRS). glTF node.rotation is ALREADY a quaternion, so we
    //     pass it straight through (no quat→euler conversion — the collapse pinned
    //     Transform on quats end-to-end; converting here would re-introduce the
    //     euler-treated-as-quat bug class AGENTS.md #6 warns about).
    //   - MeshFilter{assetHandle: HANDLE_CUBE(=1)}: a VISIBLE builtin placeholder.
    //     Custom-mesh registration from an imported GLB is engine-MVP-OOS
    //     (engine mesh-filter.ts:44 `feat-future-asset-system`); until then a
    //     builtin cube is an honest, rendering placeholder — NOT a silently
    //     dropped component. `HANDLE_CUBE` is the u32 shared-handle constant `1`
    //     (engine asset-registry.ts:185); platform-io is engine-dep-free by
    //     design (this file's header), so we emit the literal with this anchor
    //     rather than importing @forgeax/engine-runtime (would break the backend's
    //     zero-engine isolation + the workspace DAG).
    // The editor auto-adds a default-material MeshRenderer when MeshFilter is
    // present (document.ts spawnComponentData), so no Material component is needed.
    const HANDLE_CUBE = 1; // engine asset-registry.ts:185 HANDLE_CUBE = toShared(1)

    let nextId = 1;
    const entitiesArr: Array<{ id: number; name: string; parent: number | null; components: Record<string, unknown> }> = [];

    function walkNode(nodeIdx: number, parentId: number | null): void {
      const n = nodes[nodeIdx];
      if (!n) return;
      const id = nextId++;
      const [tx = 0, ty = 0, tz = 0] = n.translation ?? [];
      const [sx = 1, sy = 1, sz = 1] = n.scale ?? [];
      const [qx = 0, qy = 0, qz = 0, qw = 1] = n.rotation ?? [];
      const transform = {
        pos: [tx, ty, tz],
        quat: [qx, qy, qz, qw],
        scale: [sx, sy, sz],
      };
      const components: Record<string, unknown> = { Transform: transform };

      if (n.mesh !== undefined) {
        // Visible builtin placeholder (see block comment). The editor adds a
        // default-material MeshRenderer automatically when MeshFilter is present.
        components.MeshFilter = { assetHandle: HANDLE_CUBE };
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
