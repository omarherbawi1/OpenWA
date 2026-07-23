import type { PluginContext } from '../../../core/plugins';

jest.mock('../../../engine/adapters/zapo.adapter', () => ({
  ZapoAdapter: jest.fn().mockImplementation((config: unknown) => ({ config })),
}));

import { ZapoAdapter } from '../../../engine/adapters/zapo.adapter';
import { ZapoPlugin } from './index';

describe('ZapoPlugin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes the configured Zapo auth directory and neutral per-call fields to the adapter', () => {
    const plugin = new ZapoPlugin();
    void plugin.onLoad({
      config: { zapo: { authDir: '/data/zapo' } },
      logger: { log: jest.fn() },
    } as unknown as PluginContext);

    plugin.createEngine({
      sessionId: 'voice-session',
      dbSessionId: 'db-1',
      proxyUrl: 'http://proxy',
      proxyType: 'http',
    });

    expect(ZapoAdapter).toHaveBeenCalledWith({
      sessionId: 'voice-session',
      authDir: '/data/zapo',
      proxyUrl: 'http://proxy',
      proxyType: 'http',
    });
  });

  it('uses constructor config before onLoad and falls back to the default auth directory', () => {
    new ZapoPlugin({ zapo: { authDir: '/operator/zapo' } }).createEngine({ sessionId: 'configured' });
    new ZapoPlugin().createEngine({ sessionId: 'defaulted' });

    expect(ZapoAdapter).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'configured', authDir: '/operator/zapo' }),
    );
    expect(ZapoAdapter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'defaulted', authDir: './data/zapo' }),
    );
  });

  it('advertises only the implemented first-slice features and reports zapo-js 1.5.0', () => {
    const plugin = new ZapoPlugin();
    expect(plugin.getFeatures()).toEqual([
      'text-messages',
      'chat-list',
      'chat-history',
      'typing-indicator',
      'read-receipts',
      'pairing-code',
      'persistent-auth',
      'voice-calls',
    ]);
    expect(plugin.getEngineLibrary()).toEqual({ name: 'zapo-js', version: '1.5.0' });
  });
});
