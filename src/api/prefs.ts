/** /api/prefs —— 客户端 UI 偏好的服务端镜像入口。
 *
 *  目前只挂 uninstalled-agents（agent 是否「已安装」）。前端 store 在每次切换
 *  时 PUT 进来；服务端 buildRoster / list_subagents 同步读取过滤。
 */

import { Hono } from 'hono';
import { readUninstalledAgentIds, writeUninstalledAgentIds } from './lib/agent-prefs';
import {
  readBrowserLocalStorageSnapshot,
  writeBrowserLocalStorageSnapshot,
  type BrowserLocalStorageSnapshot,
} from './lib/browser-localStorage-prefs';

export function createPrefsRouter(projectRoot: string) {
  const r = new Hono();

  r.get('/uninstalled-agents', (c) => {
    return c.json({ ids: readUninstalledAgentIds() });
  });

  r.put('/uninstalled-agents', async (c) => {
    let body: { ids?: unknown };
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!Array.isArray(body.ids)) {
      return c.json({ error: 'ids: string[] required' }, 400);
    }
    const ids = (body.ids as unknown[]).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    try {
      writeUninstalledAgentIds(ids);
      return c.json({ ok: true, ids });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  r.get('/browser-localStorage', (c) => {
    const snap = readBrowserLocalStorageSnapshot(projectRoot);
    return c.json(snap ?? { v: 1, exportedAt: new Date().toISOString(), entries: {} });
  });

  r.put('/browser-localStorage', async (c) => {
    let body: Partial<BrowserLocalStorageSnapshot> & { entries?: unknown };
    try {
      body = await c.req.json() as typeof body;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!body.entries || typeof body.entries !== 'object' || Array.isArray(body.entries)) {
      return c.json({ error: 'entries: Record<string,string> required' }, 400);
    }
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.entries as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') entries[k] = v;
    }
    const snapshot: BrowserLocalStorageSnapshot = {
      v: 1,
      exportedAt: typeof body.exportedAt === 'string' ? body.exportedAt : new Date().toISOString(),
      origin: typeof body.origin === 'string' ? body.origin : undefined,
      entries,
    };
    try {
      writeBrowserLocalStorageSnapshot(projectRoot, snapshot);
      return c.json({ ok: true, keys: Object.keys(entries).length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  return r;
}
