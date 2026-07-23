import { REQUIRED_ROLE_KEY, SESSION_SCOPED_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { CallController } from './call.controller';
import { CallService } from './call.service';

describe('CallController', () => {
  const call = {
    id: 'call-1',
    peerId: '628123@c.us',
    direction: 'outgoing' as const,
    state: 'initiating' as const,
    media: 'audio' as const,
    muted: false,
    createdAt: '2026-07-13T00:00:00.000Z',
    canAccept: false,
    canReject: false,
  };
  let service: {
    list: jest.Mock;
    get: jest.Mock;
    start: jest.Mock;
    accept: jest.Mock;
    reject: jest.Mock;
    end: jest.Mock;
    mute: jest.Mock;
  };
  let controller: CallController;

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue([call]),
      get: jest.fn().mockResolvedValue(call),
      start: jest.fn().mockResolvedValue(call),
      accept: jest.fn().mockResolvedValue(undefined),
      reject: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      mute: jest.fn().mockResolvedValue(undefined),
    };
    controller = new CallController(service as unknown as CallService);
  });

  it('is session scoped and keeps reads available to authenticated viewers', () => {
    expect(Reflect.getMetadata(SESSION_SCOPED_KEY, CallController)).toBe(true);
    for (const method of ['list', 'get'] as const) {
      expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, controller[method])).toBeUndefined();
    }
  });

  it.each(['start', 'startRest', 'accept', 'reject', 'end', 'mute'] as const)('%s requires OPERATOR', method => {
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, controller[method])).toBe(ApiKeyRole.OPERATOR);
  });

  it('delegates start and lifecycle actions with session/call ownership parameters', async () => {
    await expect(controller.start('sess-1', { peerId: '628123@c.us' })).resolves.toBe(call);
    await expect(controller.accept('sess-1', 'call-1')).resolves.toEqual({ success: true });
    await expect(controller.reject('sess-1', 'call-1', { reason: 'busy' })).resolves.toEqual({ success: true });
    await expect(controller.end('sess-1', 'call-1', { reason: 'done' })).resolves.toEqual({ success: true });
    await expect(controller.mute('sess-1', 'call-1', { muted: true })).resolves.toEqual({ success: true });

    expect(service.start).toHaveBeenCalledWith('sess-1', '628123@c.us');
    expect(service.accept).toHaveBeenCalledWith('sess-1', 'call-1');
    expect(service.reject).toHaveBeenCalledWith('sess-1', 'call-1', 'busy');
    expect(service.end).toHaveBeenCalledWith('sess-1', 'call-1', 'done');
    expect(service.mute).toHaveBeenCalledWith('sess-1', 'call-1', true);
  });
});
