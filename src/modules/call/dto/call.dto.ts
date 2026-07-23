import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type {
  VoiceCall,
  VoiceCallDirection,
  VoiceCallState,
} from '../../../engine/interfaces/voice-call-engine.interface';

const VOICE_CALL_DIRECTIONS: VoiceCallDirection[] = ['incoming', 'outgoing'];
const VOICE_CALL_STATES: VoiceCallState[] = [
  'initiating',
  'ringing',
  'incoming_ringing',
  'connecting',
  'active',
  'on_hold',
  'ended',
];

export class StartCallDto {
  @ApiProperty({
    description: 'Neutral WhatsApp peer ID',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  peerId: string;
}

export class RejectCallDto {
  @ApiPropertyOptional({ description: 'Optional rejection reason', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class EndCallDto {
  @ApiPropertyOptional({ description: 'Optional end reason', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class MuteCallDto {
  @ApiProperty({ description: 'Whether outgoing microphone audio is muted', example: true })
  @IsBoolean()
  muted: boolean;
}

export class VoiceCallResponseDto implements VoiceCall {
  @ApiProperty({ description: 'Engine-neutral call ID' })
  id: string;

  @ApiProperty({ description: 'Neutral WhatsApp peer ID', example: '628123456789@c.us' })
  peerId: string;

  @ApiProperty({ enum: VOICE_CALL_DIRECTIONS })
  direction: VoiceCallDirection;

  @ApiProperty({ enum: VOICE_CALL_STATES })
  state: VoiceCallState;

  @ApiProperty({ enum: ['audio'] })
  media: 'audio';

  @ApiProperty()
  muted: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiPropertyOptional({ format: 'date-time' })
  connectedAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  endedAt?: string;

  @ApiPropertyOptional({ minimum: 0 })
  durationSeconds?: number;

  @ApiPropertyOptional()
  endReason?: string;

  @ApiProperty()
  canAccept: boolean;

  @ApiProperty()
  canReject: boolean;
}

export class CallActionResponseDto {
  @ApiProperty({ example: true })
  success: boolean;
}
