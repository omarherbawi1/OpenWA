import { Injectable } from '@nestjs/common';

/** Why an API key's live WebSocket sockets are being torn down. */
export type ApiKeyEvictionReason = 'revoked' | 'deleted' | 'authorization_changed';

/**
 * Implemented by WebSocket gateways that retain authenticated sockets.
 *
 * Gateways register with {@link WebSocketEvictionRegistry} instead of being
 * injected into AuthService. This keeps AuthModule independent of every
 * WebSocket feature module while still allowing immediate key revocation.
 */
export interface ApiKeySocketEvictor {
  evictApiKey(keyId: string, reason: ApiKeyEvictionReason): void;
}

@Injectable()
export class WebSocketEvictionRegistry {
  private readonly evictors = new Set<ApiKeySocketEvictor>();

  register(evictor: ApiKeySocketEvictor): () => void {
    this.evictors.add(evictor);
    return () => this.evictors.delete(evictor);
  }

  evictApiKey(keyId: string, reason: ApiKeyEvictionReason): void {
    for (const evictor of this.evictors) {
      try {
        evictor.evictApiKey(keyId, reason);
      } catch {
        // Best-effort fan-out: one unavailable gateway must not prevent the
        // remaining namespaces from dropping an invalid credential.
      }
    }
  }
}
