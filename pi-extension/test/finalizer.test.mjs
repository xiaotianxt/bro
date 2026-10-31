import { expect, it, vi } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { installBroPiExtension } from '../src/index.ts';

// Runtime contract across independently typechecked packages. Only the browser
// APIs are mocked; Pi receives the actual production finalizer's MCP content.
vi.mock('../../extension/src/background/navigation.js', () => ({ navigateDocument: vi.fn() }));
vi.mock('../../extension/src/background/render-pump.js', () => ({ keepRendering: vi.fn() }));

it('warns on actual finalization failure and retains only failed cleanup ownership', async () => {
  const state = { 'session_owned_tabs_pi-session-1': [42, 43, 44] };
  const remove = vi.fn(async (id) => {
    if (id === 42) throw new Error('existing tab removal denied');
    if (id === 43) throw new Error('No tab with id: 43');
  });
  vi.stubGlobal('chrome', {
    storage: { session: {
      get: vi.fn(async (key) => ({ [key]: state[key] })),
      set: vi.fn(async (values) => { Object.assign(state, values); }),
      remove: vi.fn(async (keys) => { for (const key of keys) delete state[key]; }),
    } },
    tabs: { remove, query: vi.fn(async () => [{ id: 42 }]) },
  });
  try {
    await import('../../extension/src/background/tools/tabs.js');
    const { dispatchTool } = await import('../../extension/src/background/tool-registry.js');
    const handlers = new Map();
    const pi = {
      registerTool() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
      on: (event, handler) => handlers.set(event, handler),
    };
    const context = {
      sessionManager: { getSessionId: () => 'pi-session-1', getSessionName: () => 'Cleanup test', getBranch: () => [] },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    };
    const finalizerResults = [];
    const client = {
      connected: true,
      async listTools() { return []; },
      async callTool(name, args) {
        const result = CallToolResultSchema.parse(await dispatchTool(name, 0, args));
        if (name === 'tabs_finalize') finalizerResults.push(result);
        return result;
      },
      close: vi.fn(async () => {}),
    };
    installBroPiExtension(pi, { createClient: () => client });
    await handlers.get('session_start')({}, context);
    await handlers.get('session_shutdown')({ reason: 'quit' }, context);
    expect(finalizerResults).toEqual([expect.objectContaining({ isError: true })]);
    expect(context.ui.notify).toHaveBeenCalledWith(expect.stringContaining('cleanup incomplete'), 'warning');
    expect(state['session_owned_tabs_pi-session-1']).toEqual([42]);
    expect(client.close).toHaveBeenCalledOnce();
    remove.mockResolvedValue(undefined);
    const retry = await dispatchTool('tabs_finalize', 0, { sessionId: 'pi-session-1' });
    expect(retry.isError).not.toBe(true);
    expect(state['session_owned_tabs_pi-session-1']).toBeUndefined();
    expect(remove.mock.calls.map(([id]) => id)).toEqual([42, 43, 44, 42]);
  } finally {
    vi.unstubAllGlobals();
  }
});
