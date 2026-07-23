// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));
// The app graph registers Baileys even when Zapo is selected; no Baileys socket is needed for this boot gate.
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  fetchLatestBaileysVersion: jest.fn(),
  getContentType: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { EngineFactory } from './../src/engine/engine.factory';

describe('Zapo engine boot (e2e)', () => {
  let app: INestApplication<App>;
  let factory: EngineFactory;
  const previousEngine = process.env.ENGINE_TYPE;

  beforeAll(async () => {
    process.env.ENGINE_TYPE = 'zapo';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    factory = moduleFixture.get(EngineFactory);
  });

  afterAll(async () => {
    if (previousEngine === undefined) delete process.env.ENGINE_TYPE;
    else process.env.ENGINE_TYPE = previousEngine;
    try {
      await app?.close();
    } catch {
      // Ignore the existing teardown-only multi-datasource quirk.
    }
  });

  it('selects Zapo as the current engine', () => {
    expect(factory.getCurrentEngine()).toBe('zapo');
  });

  it('registers and enables the voice-capable Zapo plugin', () => {
    const zapo = factory.getAvailableEngines().find(engine => engine.id === 'zapo');
    expect(zapo).toBeDefined();
    expect(zapo?.enabled).toBe(true);
    expect(zapo?.features).toContain('voice-calls');
    expect(zapo?.features).toContain('persistent-auth');
  });
});
