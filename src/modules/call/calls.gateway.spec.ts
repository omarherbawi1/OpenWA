import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Socket } from 'socket.io';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { WebSocketEvictionRegistry } from '../auth/websocket-eviction.registry';
import { CallAudioFrame, CallEndedListener, CallService } from './call.service';
import { buildCallRoom, CallsGateway, MAX_CALL_UPLINK_BYTES } from './calls.gateway';

interface MockSocket {
  id: string;
  handshake: {
    headers: Record<string, string>;
    query: Record<string, string>;
    auth: { apiKey?: string };
    address: string;
  };
  data: Record<string, unknown>;
  emit: jest.Mock;
  disconnect: jest.Mock;
  join: jest.Mock;
  leave: jest.Mock;
}

const apiKey = (overrides: Partial<ApiKey> = {}): ApiKey =>
  ({
    id: 'key-1',
    name: 'operator',
    role: ApiKeyRole.OPERATOR,
    allowedSessions: null,
    ...overrides,
  }) as ApiKey;

describe('CallsGateway', () => {
  let gateway: CallsGateway;
  let authService: { validateApiKey: jest.Mock; hasPermission: jest.Mock };
  let auditService: { logWarn: jest.Mock };
  let callService: {
    onAudio: jest.Mock;
    onEnded: jest.Mock;
    openMedia: jest.Mock;
    closeMedia: jest.Mock;
    feedAudio: jest.Mock;
  };
  let registry: WebSocketEvictionRegistry;
  let audioListener: (frame: CallAudioFrame) => void;
  let endedListener: CallEndedListener;

  const makeSocket = (auth: { apiKey?: string } = {}, id = 'socket-1'): MockSocket => ({
    id,
    handshake: { headers: {}, query: {}, auth, address: '203.0.113.9' },
    data: {},
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
  });
  const asSocket = (socket: MockSocket): Socket => socket as unknown as Socket;

  beforeEach(() => {
    authService = {
      validateApiKey: jest.fn().mockResolvedValue(apiKey()),
      hasPermission: jest.fn((key: ApiKey, role: ApiKeyRole) => {
        const rank = { [ApiKeyRole.VIEWER]: 1, [ApiKeyRole.OPERATOR]: 2, [ApiKeyRole.ADMIN]: 3 };
        return rank[key.role] >= rank[role];
      }),
    };
    auditService = { logWarn: jest.fn().mockResolvedValue(undefined) };
    callService = {
      onAudio: jest.fn((listener: (frame: CallAudioFrame) => void) => {
        audioListener = listener;
        return jest.fn();
      }),
      onEnded: jest.fn((listener: CallEndedListener) => {
        endedListener = listener;
        return jest.fn();
      }),
      openMedia: jest.fn().mockResolvedValue({
        call: { id: 'call-1', state: 'active' },
        watermarks: { pauseMs: 500, resumeMs: 200 },
      }),
      closeMedia: jest.fn(),
      feedAudio: jest.fn().mockReturnValue(100),
    };
    registry = new WebSocketEvictionRegistry();
    gateway = new CallsGateway(
      authService as unknown as AuthService,
      auditService as unknown as AuditService,
      callService as unknown as CallService,
      registry,
    );
  });

  afterEach(() => gateway.onModuleDestroy());

  it('accepts credentials only from handshake auth or X-API-Key, never the query string', async () => {
    const socket = makeSocket();
    socket.handshake.query.apiKey = 'leaked';

    await gateway.handleConnection(asSocket(socket));

    expect(authService.validateApiKey).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('requires OPERATOR at connection time', async () => {
    authService.validateApiKey.mockResolvedValue(apiKey({ role: ApiKeyRole.VIEWER }));
    const socket = makeSocket({ apiKey: 'viewer-key' });

    await gateway.handleConnection(asSocket(socket));

    expect(socket.emit).toHaveBeenCalledWith('call:error', expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('uses X-Forwarded-For only when the immediate peer is trusted', async () => {
    const previous = process.env.TRUSTED_PROXIES;
    process.env.TRUSTED_PROXIES = '10.0.0.1';
    try {
      const socket = makeSocket({ apiKey: 'good' });
      socket.handshake.address = '10.0.0.1';
      socket.handshake.headers['x-forwarded-for'] = '198.51.100.8';

      await gateway.handleConnection(asSocket(socket));

      expect(authService.validateApiKey).toHaveBeenCalledWith('good', '198.51.100.8');
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXIES;
      else process.env.TRUSTED_PROXIES = previous;
    }
  });

  it('allows an immediate join while asynchronous connection authentication is still pending', async () => {
    let finishConnectionAuth: (key: ApiKey) => void;
    authService.validateApiKey
      .mockImplementationOnce(
        () =>
          new Promise<ApiKey>(resolve => {
            finishConnectionAuth = resolve;
          }),
      )
      .mockResolvedValueOnce(apiKey());
    const socket = makeSocket({ apiKey: 'good' });

    const connection = gateway.handleConnection(asSocket(socket));
    const response = await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });
    finishConnectionAuth!(apiKey());
    await connection;

    expect(response).toEqual(expect.objectContaining({ ok: true, sessionId: 'sess-1', callId: 'call-1' }));
    expect(authService.validateApiKey).toHaveBeenNthCalledWith(2, 'good', '203.0.113.9', 'sess-1');
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('revalidates IP, allowedSessions, and role when joining an owned call', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));

    const response = await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    expect(response).toEqual(
      expect.objectContaining({ ok: true, sessionId: 'sess-1', callId: 'call-1', sampleRate: 16_000 }),
    );
    expect(authService.validateApiKey).toHaveBeenLastCalledWith('good', '203.0.113.9', 'sess-1');
    expect(callService.openMedia).toHaveBeenCalledWith('sess-1', 'call-1');
    expect(socket.join).toHaveBeenCalledWith(buildCallRoom('sess-1', 'call-1'));
    expect(socket.emit).toHaveBeenCalledWith('joined', expect.objectContaining({ callId: 'call-1' }));
  });

  it('rejects a join when the fresh key is not authorized for that session', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    authService.validateApiKey.mockRejectedValueOnce(new UnauthorizedException('wrong session'));

    const response = await gateway.handleJoin(asSocket(socket), { sessionId: 'foreign', callId: 'call-1' });

    expect(response.code).toBe('UNAUTHORIZED');
    expect(callService.openMedia).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects and tears down media when the freshly validated role is no longer OPERATOR', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    authService.validateApiKey.mockResolvedValueOnce(apiKey({ role: ApiKeyRole.VIEWER }));

    const response = await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    expect(response.code).toBe('FORBIDDEN');
    expect(callService.openMedia).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('maps failed call ownership verification to CALL_NOT_FOUND', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    callService.openMedia.mockRejectedValueOnce(new NotFoundException('foreign call'));

    const response = await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'foreign' });

    expect(response.code).toBe('CALL_NOT_FOUND');
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('disables external media if joining the Socket.IO room fails', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    socket.join.mockRejectedValueOnce(new Error('adapter failed'));
    await gateway.handleConnection(asSocket(socket));

    const response = await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    expect(response.code).toBe('INVALID_CALL');
    expect(callService.closeMedia).toHaveBeenCalledWith('sess-1', 'call-1');
  });

  it('accepts normalized Float32Array and little-endian Buffer uplink frames', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });
    const bytes = Buffer.alloc(4);
    bytes.writeFloatLE(0.5);

    const floatResponse = gateway.handleUplink(asSocket(socket), new Float32Array([0, -0.5, 1]));
    const bufferResponse = gateway.handleUplink(asSocket(socket), bytes);

    expect(floatResponse).toEqual(expect.objectContaining({ ok: true, accepted: true }));
    expect(bufferResponse).toEqual(expect.objectContaining({ ok: true, accepted: true }));
    expect(callService.feedAudio).toHaveBeenNthCalledWith(2, 'sess-1', 'call-1', expect.objectContaining({ 0: 0.5 }));
  });

  it('closes the media flow when the engine no longer owns an uplink call', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });
    callService.feedAudio.mockImplementationOnce(() => {
      throw new NotFoundException('call no longer exists');
    });

    const failed = gateway.handleUplink(asSocket(socket), new Float32Array([0]));
    const afterClose = gateway.handleUplink(asSocket(socket), new Float32Array([0]));

    expect(failed).toEqual(expect.objectContaining({ ok: false, code: 'MEDIA_UNAVAILABLE' }));
    expect(callService.closeMedia).toHaveBeenCalledWith('sess-1', 'call-1');
    expect(socket.leave).toHaveBeenCalledWith(buildCallRoom('sess-1', 'call-1'));
    expect(afterClose).toEqual(expect.objectContaining({ ok: false, code: 'NOT_JOINED' }));
  });

  it.each([
    [{ samples: [0] }, 'Float32Array or Buffer'],
    [Buffer.alloc(3), 'align'],
    [new Float32Array([Number.NaN]), 'finite normalized'],
    [new Float32Array([1.01]), 'finite normalized'],
    [Buffer.alloc(MAX_CALL_UPLINK_BYTES + 4), 'bytes'],
  ])('rejects malformed or oversized raw uplink %#', async (payload, message) => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    const response = gateway.handleUplink(asSocket(socket), payload as Buffer);

    expect(response).toEqual(expect.objectContaining({ ok: false, code: 'INVALID_AUDIO' }));
    expect(response.message).toContain(message);
    expect(callService.feedAudio).not.toHaveBeenCalled();
  });

  it('enforces an aggregate 16 kHz token-bucket rate guard per call', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    const first = gateway.handleUplink(asSocket(socket), new Float32Array(16_000));
    const overRate = gateway.handleUplink(asSocket(socket), new Float32Array([0]));

    expect(first.accepted).toBe(true);
    expect(overRate.code).toBe('UPLINK_RATE_EXCEEDED');
    expect(callService.feedAudio).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('allows only one operator socket to control a call microphone at a time', async () => {
    const first = makeSocket({ apiKey: 'good' }, 'socket-1');
    const second = makeSocket({ apiKey: 'good' }, 'socket-2');
    await gateway.handleConnection(asSocket(first));
    await gateway.handleConnection(asSocket(second));
    await gateway.handleJoin(asSocket(first), { sessionId: 'sess-1', callId: 'call-1' });
    await gateway.handleJoin(asSocket(second), { sessionId: 'sess-1', callId: 'call-1' });

    expect(gateway.handleUplink(asSocket(first), new Float32Array([0]))).toEqual(
      expect.objectContaining({ ok: true, accepted: true }),
    );
    expect(gateway.handleUplink(asSocket(second), new Float32Array([0]))).toEqual(
      expect.objectContaining({ ok: false, code: 'UPLINK_NOT_OWNER' }),
    );

    gateway.handleDisconnect(asSocket(first));
    expect(gateway.handleUplink(asSocket(second), new Float32Array([0]))).toEqual(
      expect.objectContaining({ ok: true, accepted: true }),
    );
  });

  it('drops uplink while above the engine pause watermark and resumes after queue drain', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    callService.feedAudio.mockReturnValueOnce(600).mockReturnValueOnce(100);
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    const first = gateway.handleUplink(asSocket(socket), new Float32Array([0]));
    const dropped = gateway.handleUplink(asSocket(socket), new Float32Array([0]));
    now.mockReturnValue(1_401);
    const resumed = gateway.handleUplink(asSocket(socket), new Float32Array([0]));

    expect(first).toEqual(expect.objectContaining({ accepted: true, paused: true }));
    expect(dropped).toEqual(expect.objectContaining({ accepted: false, paused: true }));
    expect(resumed).toEqual(expect.objectContaining({ accepted: true, paused: false }));
    expect(callService.feedAudio).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('emits engine downlink as binary only to the joined call room', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    const emit = jest.fn();
    (gateway as unknown as { server: unknown }).server = { to: jest.fn().mockReturnValue({ emit }) };
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    audioListener({
      sessionId: 'sess-1',
      callId: 'call-1',
      pcm: new Float32Array([0.25, -0.25]),
    });

    expect((gateway as unknown as { server: { to: jest.Mock } }).server.to).toHaveBeenCalledWith(
      buildCallRoom('sess-1', 'call-1'),
    );
    expect(emit).toHaveBeenCalledWith('call:downlink', expect.any(Buffer));
  });

  it('leaves and closes media, and notifies joined clients when a call ends', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    const emit = jest.fn();
    (gateway as unknown as { server: unknown }).server = { to: jest.fn().mockReturnValue({ emit }) };
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    endedListener({
      sessionId: 'sess-1',
      call: {
        id: 'call-1',
        peerId: '628123@c.us',
        direction: 'outgoing',
        state: 'ended',
        media: 'audio',
        muted: false,
        createdAt: '2026-07-13T00:00:00.000Z',
        canAccept: false,
        canReject: false,
      },
    });
    endedListener({
      sessionId: 'sess-1',
      call: {
        id: 'call-1',
        peerId: '628123@c.us',
        direction: 'outgoing',
        state: 'ended',
        media: 'audio',
        muted: false,
        createdAt: '2026-07-13T00:00:00.000Z',
        canAccept: false,
        canReject: false,
      },
    });

    expect(emit).toHaveBeenCalledWith('call-ended', expect.objectContaining({ id: 'call-1' }));
    expect(callService.closeMedia).toHaveBeenCalledTimes(1);
    expect(callService.closeMedia).toHaveBeenCalledWith('sess-1', 'call-1');
    expect(socket.leave).toHaveBeenCalledWith(buildCallRoom('sess-1', 'call-1'));
    expect(gateway.handleLeave(asSocket(socket))).toEqual({ ok: true });
  });

  it('is evicted through the shared registry and closes call media', async () => {
    const socket = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleJoin(asSocket(socket), { sessionId: 'sess-1', callId: 'call-1' });

    registry.evictApiKey('key-1', 'revoked');

    expect(callService.closeMedia).toHaveBeenCalledWith('sess-1', 'call-1');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
