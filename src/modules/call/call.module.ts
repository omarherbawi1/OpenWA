import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { SessionModule } from '../session/session.module';
import { WebhookModule } from '../webhook/webhook.module';
import { CallController } from './call.controller';
import { CallService } from './call.service';
import { CallsGateway } from './calls.gateway';

@Module({
  imports: [AuthModule, EventsModule, SessionModule, WebhookModule],
  controllers: [CallController],
  providers: [CallService, CallsGateway],
  exports: [CallService, CallsGateway],
})
export class CallModule {}
