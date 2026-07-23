import { WebSocketEvictionRegistry } from './websocket-eviction.registry';

describe('WebSocketEvictionRegistry', () => {
  it('evicts every registered gateway and isolates a failing namespace', () => {
    const registry = new WebSocketEvictionRegistry();
    const first = { evictApiKey: jest.fn(() => void 0) };
    const failing = {
      evictApiKey: jest.fn(() => {
        throw new Error('unavailable');
      }),
    };
    const last = { evictApiKey: jest.fn(() => void 0) };
    registry.register(first);
    registry.register(failing);
    registry.register(last);

    registry.evictApiKey('key-1', 'authorization_changed');

    expect(first.evictApiKey).toHaveBeenCalledWith('key-1', 'authorization_changed');
    expect(failing.evictApiKey).toHaveBeenCalled();
    expect(last.evictApiKey).toHaveBeenCalledWith('key-1', 'authorization_changed');
  });

  it('unregisters a gateway cleanly', () => {
    const registry = new WebSocketEvictionRegistry();
    const gateway = { evictApiKey: jest.fn() };
    const unregister = registry.register(gateway);
    unregister();

    registry.evictApiKey('key-1', 'revoked');

    expect(gateway.evictApiKey).not.toHaveBeenCalled();
  });
});
