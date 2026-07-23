/**
 * Zapo Engine Plugin
 * Built-in linked-device engine backed by zapo-js.
 */

import { IEnginePlugin, PluginContext, PluginType } from '../../../core/plugins';
import { ZapoAdapter } from '../../../engine/adapters/zapo.adapter';
import { IWhatsAppEngine } from '../../../engine/interfaces/whatsapp-engine.interface';

export class ZapoPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

  constructor(private readonly registeredConfig?: Record<string, unknown>) {}

  onLoad(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.log('Zapo engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    context.logger.log('Zapo engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('Zapo engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    const engineConfig = (this.context?.config ?? this.registeredConfig ?? {}) as {
      zapo?: { authDir?: string };
    };

    return new ZapoAdapter({
      sessionId: config.sessionId as string,
      authDir: engineConfig.zapo?.authDir ?? './data/zapo',
      proxyUrl: config.proxyUrl as string | undefined,
      proxyType: config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined,
    });
  }

  getFeatures(): string[] {
    return [
      'text-messages',
      'chat-list',
      'chat-history',
      'typing-indicator',
      'read-receipts',
      'pairing-code',
      'persistent-auth',
      'voice-calls',
    ];
  }

  getEngineLibrary(): { name: string; version: string } {
    let version = 'unknown';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      version = (require('zapo-js/package.json') as { version: string }).version;
    } catch {
      // Keep 'unknown' if package metadata is unavailable at runtime.
    }
    return { name: 'zapo-js', version };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await Promise.all([
        import('zapo-js'),
        import('@zapo-js/store-sqlite'),
        import('@zapo-js/voip'),
        import('@roamhq/wrtc'),
        import('libmlow-wasm'),
        import('ws'),
        import('socks-proxy-agent'),
      ]);
      return { healthy: true, message: 'Zapo voice engine, media, and proxy dependencies are available' };
    } catch (error) {
      return {
        healthy: false,
        message: `Zapo voice dependency failed to load: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export default ZapoPlugin;
