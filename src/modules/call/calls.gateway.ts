import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { HttpException, Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { resolveClientIp as resolveRequestClientIp, type RequestLike } from '../../common/utils/ip';
import { resolveCorsPolicy } from '../../config/bootstrap-security';
import { VOICE_CALL_SAMPLE_RATE } from '../../engine/interfaces/voice-call-engine.interface';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuthService } from '../auth/auth.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import {
  WebSocketEvictionRegistry,
  type ApiKeyEvictionReason,
  type ApiKeySocketEvictor,
} from '../auth/websocket-eviction.registry';
import { CallService, type CallAudioFrame } from './call.service';

export const MAX_CALL_UPLINK_BYTES = VOICE_CALL_SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT;

const EVICTION_MESSAGES: Record<ApiKeyEvictionReason, string> = {
  revoked: 'API key has been revoked',
  deleted: 'API key has been deleted',
  authorization_changed: 'API key authorization changed; please reconnect',
};

interface CallJoinRequest {
  sessionId: string;
  callId: string;
}

interface CallGatewayResponse {
  ok: boolean;
  code?: string;
  message?: string;
  sessionId?: string;
  callId?: string;
  sampleRate?: number;
  accepted?: boolean;
  queuedMs?: number;
  paused?: boolean;
  retryAfterMs?: number;
}

interface JoinedCall {
  sessionId: string;
  callId: string;
  room: string;
}

interface CallsSocketData {
  apiKey?: ApiKey;
  rawApiKey?: string;
  joinedCall?: JoinedCall;
}

interface MediaFlow {
  sessionId: string;
  callId: string;
  sockets: Set<Socket>;
  uplinkSocketId?: string;
  watermarks: { pauseMs: number; resumeMs: number };
  tokens: number;
  tokenUpdatedAt: number;
  queuedMs: number;
  queueUpdatedAt: number;
  paused: boolean;
}

function resolveWsCorsOrigin(): boolean | string[] {
  const policy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  return policy.allowAnyOrigin ? true : policy.origins;
}

function readTrustedProxies(): string[] {
  return (process.env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

export function buildCallRoom(sessionId: string, callId: string): string {
  return `session:${sessionId}:call:${callId}`;
}

@WebSocketGateway({
  cors: {
    origin: resolveWsCorsOrigin(),
  },
  namespace: '/calls',
})
export class CallsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy, ApiKeySocketEvictor
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(CallsGateway.name);
  private readonly socketsByKeyId = new Map<string, Set<Socket>>();
  private readonly mediaFlows = new Map<string, MediaFlow>();
  private readonly unregisterEvictor: () => void;
  private readonly unsubscribeAudio: () => void;
  private readonly unsubscribeEnded: () => void;

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
    private readonly callService: CallService,
    evictionRegistry: WebSocketEvictionRegistry,
  ) {
    this.unregisterEvictor = evictionRegistry.register(this);
    this.unsubscribeAudio = callService.onAudio(frame => this.emitDownlink(frame));
    this.unsubscribeEnded = callService.onEnded(({ sessionId, call }) => this.emitCallEnded(sessionId, call.id, call));
  }

  afterInit(): void {
    this.logger.log('Voice-call media gateway initialized');
  }

  onModuleDestroy(): void {
    this.unregisterEvictor();
    this.unsubscribeAudio();
    this.unsubscribeEnded();
    for (const flow of [...this.mediaFlows.values()]) {
      this.closeFlow(flow);
    }
    this.socketsByKeyId.clear();
  }

  async handleConnection(client: Socket): Promise<void> {
    const auth = client.handshake.auth as { apiKey?: unknown } | undefined;
    const header = client.handshake.headers['x-api-key'];
    const headerKey = Array.isArray(header) ? header[0] : header;
    const rawApiKey =
      typeof auth?.apiKey === 'string' && auth.apiKey
        ? auth.apiKey
        : typeof headerKey === 'string' && headerKey
          ? headerKey
          : undefined;
    const clientIp = this.resolveClientIp(client);

    if (!rawApiKey) {
      this.auditAuthFailure(clientIp, 'missing API key');
      this.rejectClient(client, 'UNAUTHORIZED', 'API key required');
      return;
    }

    // Socket.IO can deliver client events as soon as its connect packet is acknowledged, before this
    // async hook has finished database validation. Store the handshake credential synchronously so an
    // immediate join can perform its own fresh, session-scoped validation instead of failing the race.
    const data = client.data as CallsSocketData;
    data.rawApiKey = rawApiKey;

    try {
      const apiKey = await this.authService.validateApiKey(rawApiKey, clientIp);
      if (!this.authService.hasPermission(apiKey, ApiKeyRole.OPERATOR)) {
        this.auditAuthFailure(clientIp, 'operator role required');
        this.rejectClient(client, 'FORBIDDEN', 'Operator role required');
        return;
      }

      data.apiKey = apiKey;
      this.trackSocket(apiKey.id, client);
    } catch (error) {
      delete data.rawApiKey;
      this.auditAuthFailure(clientIp, error instanceof Error ? error.message : String(error));
      this.rejectClient(client, 'UNAUTHORIZED', 'Authentication failed');
    }
  }

  handleDisconnect(client: Socket): void {
    this.detachMedia(client, false);
    this.untrackSocket(client);
  }

  evictApiKey(keyId: string, reason: ApiKeyEvictionReason = 'revoked'): void {
    const sockets = this.socketsByKeyId.get(keyId);
    if (!sockets || sockets.size === 0) return;
    this.socketsByKeyId.delete(keyId);

    for (const client of sockets) {
      this.detachMedia(client, false);
      const response = this.errorResponse('UNAUTHORIZED', EVICTION_MESSAGES[reason]);
      client.emit('error', response);
      client.emit('call:error', response);
      client.disconnect(true);
    }
  }

  @SubscribeMessage('join-call')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() request: CallJoinRequest,
  ): Promise<CallGatewayResponse> {
    if (
      !request ||
      typeof request !== 'object' ||
      typeof request.sessionId !== 'string' ||
      !request.sessionId ||
      typeof request.callId !== 'string' ||
      !request.callId
    ) {
      return this.emitError(client, 'INVALID_JOIN', 'sessionId and callId are required');
    }

    const data = client.data as CallsSocketData;
    const clientIp = this.resolveClientIp(client);
    let apiKey: ApiKey;
    try {
      if (!data.rawApiKey) throw new Error('Missing authenticated API key');
      apiKey = await this.authService.validateApiKey(data.rawApiKey, clientIp, request.sessionId);
      if (!this.authService.hasPermission(apiKey, ApiKeyRole.OPERATOR)) {
        this.auditAuthFailure(clientIp, 'operator role required');
        const response = this.emitError(client, 'FORBIDDEN', 'Operator role required');
        this.detachMedia(client, false);
        client.disconnect(true);
        return response;
      }
    } catch {
      const response = this.emitError(client, 'UNAUTHORIZED', 'API key is no longer authorized for this session');
      this.detachMedia(client, false);
      client.disconnect(true);
      return response;
    }

    let openedRoom: string | undefined;
    let createdFlow = false;
    try {
      const { watermarks } = await this.callService.openMedia(request.sessionId, request.callId);
      const room = buildCallRoom(request.sessionId, request.callId);
      openedRoom = room;
      const previous = data.joinedCall;
      if (previous?.sessionId === request.sessionId && previous.callId === request.callId) {
        const flow = this.mediaFlows.get(room);
        if (flow?.sockets.has(client)) {
          flow.watermarks = watermarks;
          const response = this.joinedResponse(request);
          client.emit('joined', response);
          return response;
        }
      }

      this.detachMedia(client, true);
      let flow = this.mediaFlows.get(room);
      if (!flow) {
        const now = Date.now();
        flow = {
          sessionId: request.sessionId,
          callId: request.callId,
          sockets: new Set(),
          watermarks,
          tokens: VOICE_CALL_SAMPLE_RATE,
          tokenUpdatedAt: now,
          queuedMs: 0,
          queueUpdatedAt: now,
          paused: false,
        };
        this.mediaFlows.set(room, flow);
        createdFlow = true;
      } else {
        flow.watermarks = watermarks;
      }

      await client.join(room);
      flow.sockets.add(client);
      data.joinedCall = { sessionId: request.sessionId, callId: request.callId, room };
      data.apiKey = apiKey;
      const response = this.joinedResponse(request);
      client.emit('joined', response);
      return response;
    } catch (error) {
      if (openedRoom && createdFlow) {
        const flow = this.mediaFlows.get(openedRoom);
        if (!flow || flow.sockets.size === 0) {
          this.mediaFlows.delete(openedRoom);
          this.callService.closeMedia(request.sessionId, request.callId);
        }
      }
      const code =
        error instanceof EngineNotSupportedError
          ? 'ENGINE_NOT_SUPPORTED'
          : error instanceof HttpException && error.getStatus() === 404
            ? 'CALL_NOT_FOUND'
            : 'INVALID_CALL';
      return this.emitError(client, code, error instanceof Error ? error.message : 'Unable to join call');
    }
  }

  @SubscribeMessage('leave-call')
  handleLeave(@ConnectedSocket() client: Socket): CallGatewayResponse {
    const joined = (client.data as CallsSocketData).joinedCall;
    if (!joined) {
      return { ok: true };
    }
    this.detachMedia(client, true);
    return { ok: true, sessionId: joined.sessionId, callId: joined.callId };
  }

  @SubscribeMessage('call:uplink')
  handleUplink(@ConnectedSocket() client: Socket, @MessageBody() payload: Buffer | Float32Array): CallGatewayResponse {
    const joined = (client.data as CallsSocketData).joinedCall;
    if (!joined) {
      return this.emitError(client, 'NOT_JOINED', 'Join a call before sending audio');
    }

    const parsed = this.parsePcm(payload);
    if ('error' in parsed) {
      return this.emitError(client, 'INVALID_AUDIO', parsed.error);
    }

    const flow = this.mediaFlows.get(joined.room);
    if (!flow || !flow.sockets.has(client)) {
      return this.emitError(client, 'NOT_JOINED', 'Call media session is no longer active');
    }
    if (flow.uplinkSocketId && flow.uplinkSocketId !== client.id) {
      return this.emitError(client, 'UPLINK_NOT_OWNER', 'Another operator controls this call microphone');
    }
    flow.uplinkSocketId ??= client.id;

    const now = Date.now();
    if (!this.consumeRate(flow, parsed.pcm.length, now)) {
      return this.emitError(client, 'UPLINK_RATE_EXCEEDED', 'Audio exceeds the 16 kHz real-time rate');
    }

    const queuedMs = this.estimateQueuedMs(flow, now);
    if (flow.paused && queuedMs > flow.watermarks.resumeMs) {
      flow.queuedMs = queuedMs;
      flow.queueUpdatedAt = now;
      const retryAfterMs = Math.max(20, queuedMs - flow.watermarks.resumeMs);
      client.emit('backpressure', {
        paused: true,
        queuedMs,
        retryAfterMs,
      });
      return { ok: true, accepted: false, queuedMs, paused: true, retryAfterMs };
    }
    const wasPaused = flow.paused;
    flow.paused = false;

    try {
      const nextQueuedMs = this.callService.feedAudio(joined.sessionId, joined.callId, parsed.pcm);
      flow.queuedMs = Number.isFinite(nextQueuedMs) && nextQueuedMs > 0 ? nextQueuedMs : 0;
      flow.queueUpdatedAt = now;
      flow.paused = flow.queuedMs >= flow.watermarks.pauseMs;
      if (flow.paused !== wasPaused) {
        client.emit('backpressure', {
          paused: flow.paused,
          queuedMs: flow.queuedMs,
          retryAfterMs: flow.paused ? Math.max(20, flow.queuedMs - flow.watermarks.resumeMs) : 0,
        });
      }
      return {
        ok: true,
        accepted: true,
        queuedMs: flow.queuedMs,
        paused: flow.paused,
        retryAfterMs: flow.paused ? Math.max(20, flow.queuedMs - flow.watermarks.resumeMs) : 0,
      };
    } catch (error) {
      const response = this.emitError(
        client,
        'MEDIA_UNAVAILABLE',
        error instanceof Error ? error.message : 'Audio uplink failed',
      );
      this.closeFlow(flow);
      return response;
    }
  }

  private emitDownlink(frame: CallAudioFrame): void {
    const room = buildCallRoom(frame.sessionId, frame.callId);
    const flow = this.mediaFlows.get(room);
    if (!flow || flow.sockets.size === 0 || !this.server) return;

    const bytes = Buffer.from(new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength));
    this.server.to(room).emit('call:downlink', bytes);
  }

  private emitCallEnded(sessionId: string, callId: string, call: unknown): void {
    const room = buildCallRoom(sessionId, callId);
    const flow = this.mediaFlows.get(room);
    if (!flow) return;

    this.server?.to(room).emit('call-ended', call);
    this.closeFlow(flow);
  }

  private closeFlow(flow: MediaFlow): void {
    const room = buildCallRoom(flow.sessionId, flow.callId);
    if (this.mediaFlows.get(room) !== flow) return;
    this.mediaFlows.delete(room);
    for (const client of flow.sockets) {
      const data = client.data as CallsSocketData;
      if (data.joinedCall?.room === room) {
        delete data.joinedCall;
      }
      void client.leave(room);
    }
    flow.sockets.clear();
    this.callService.closeMedia(flow.sessionId, flow.callId);
  }

  private parsePcm(payload: unknown): { pcm: Float32Array } | { error: string } {
    const byteLength =
      payload instanceof Float32Array ? payload.byteLength : Buffer.isBuffer(payload) ? payload.byteLength : -1;
    if (byteLength < 0) {
      return { error: 'Audio must be a Float32Array or Buffer' };
    }
    if (byteLength === 0 || byteLength > MAX_CALL_UPLINK_BYTES) {
      return { error: `Audio must contain 1-${MAX_CALL_UPLINK_BYTES} bytes` };
    }
    if (byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      return { error: 'Audio byte length must align to 32-bit float samples' };
    }

    let pcm: Float32Array;
    if (payload instanceof Float32Array) {
      pcm = new Float32Array(payload);
    } else {
      const buffer = payload as Buffer;
      pcm = new Float32Array(buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
      for (let index = 0; index < pcm.length; index += 1) {
        pcm[index] = buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
      }
    }

    for (const sample of pcm) {
      if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
        return { error: 'Audio samples must be finite normalized Float32 PCM values' };
      }
    }
    return { pcm };
  }

  private consumeRate(flow: MediaFlow, samples: number, now: number): boolean {
    const elapsedMs = Math.max(0, now - flow.tokenUpdatedAt);
    flow.tokens = Math.min(VOICE_CALL_SAMPLE_RATE, flow.tokens + (elapsedMs * VOICE_CALL_SAMPLE_RATE) / 1000);
    flow.tokenUpdatedAt = now;
    if (samples > flow.tokens) return false;
    flow.tokens -= samples;
    return true;
  }

  private estimateQueuedMs(flow: MediaFlow, now: number): number {
    return Math.max(0, flow.queuedMs - Math.max(0, now - flow.queueUpdatedAt));
  }

  private detachMedia(client: Socket, leaveRoom: boolean): void {
    const data = client.data as CallsSocketData;
    const joined = data.joinedCall;
    if (!joined) return;
    delete data.joinedCall;
    if (leaveRoom) void client.leave(joined.room);

    const flow = this.mediaFlows.get(joined.room);
    if (!flow) return;
    flow.sockets.delete(client);
    if (flow.uplinkSocketId === client.id) {
      delete flow.uplinkSocketId;
    }
    if (flow.sockets.size === 0) {
      this.closeFlow(flow);
    }
  }

  private trackSocket(keyId: string, client: Socket): void {
    let sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByKeyId.set(keyId, sockets);
    }
    sockets.add(client);
  }

  private untrackSocket(client: Socket): void {
    const keyId = (client.data as CallsSocketData).apiKey?.id;
    if (!keyId) return;
    const sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) return;
    sockets.delete(client);
    if (sockets.size === 0) this.socketsByKeyId.delete(keyId);
  }

  private resolveClientIp(client: Socket): string {
    const handshake = client.handshake;
    const request: RequestLike = {
      ip: handshake.address,
      socket: { remoteAddress: handshake.address },
      headers: handshake.headers ?? {},
    };
    return resolveRequestClientIp(request, readTrustedProxies());
  }

  private joinedResponse(request: CallJoinRequest): CallGatewayResponse {
    return {
      ok: true,
      sessionId: request.sessionId,
      callId: request.callId,
      sampleRate: VOICE_CALL_SAMPLE_RATE,
    };
  }

  private rejectClient(client: Socket, code: string, message: string): void {
    const response = this.errorResponse(code, message);
    client.emit('error', response);
    client.emit('call:error', response);
    client.disconnect();
  }

  private emitError(client: Socket, code: string, message: string): CallGatewayResponse {
    const response = this.errorResponse(code, message);
    client.emit('error', response);
    client.emit('call:error', response);
    return response;
  }

  private errorResponse(code: string, message: string): CallGatewayResponse {
    return { ok: false, code, message };
  }

  private auditAuthFailure(ipAddress: string, errorMessage: string): void {
    void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
      ipAddress,
      metadata: { surface: 'calls-websocket' },
      errorMessage,
    });
  }
}
