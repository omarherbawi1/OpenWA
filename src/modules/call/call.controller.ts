import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, SessionScoped } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { CallService } from './call.service';
import {
  CallActionResponseDto,
  EndCallDto,
  MuteCallDto,
  RejectCallDto,
  StartCallDto,
  VoiceCallResponseDto,
} from './dto';

@ApiTags('calls')
@Controller('sessions/:sessionId/calls')
@SessionScoped()
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Get()
  @ApiOperation({ summary: 'List current voice-call snapshots for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, type: [VoiceCallResponseDto] })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 501, description: 'Active engine does not support voice-call media' })
  list(@Param('sessionId') sessionId: string): Promise<VoiceCallResponseDto[]> {
    return this.callService.list(sessionId);
  }

  @Get(':callId')
  @ApiOperation({ summary: 'Get a voice-call snapshot' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID' })
  @ApiResponse({ status: 200, type: VoiceCallResponseDto })
  @ApiResponse({ status: 404, description: 'Session or call not found' })
  @ApiResponse({ status: 501, description: 'Active engine does not support voice-call media' })
  get(@Param('sessionId') sessionId: string, @Param('callId') callId: string): Promise<VoiceCallResponseDto> {
    return this.callService.get(sessionId, callId);
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Start an outgoing voice call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, type: VoiceCallResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid peer or session is not started' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiResponse({ status: 501, description: 'Active engine does not support voice-call media' })
  start(@Param('sessionId') sessionId: string, @Body() dto: StartCallDto): Promise<VoiceCallResponseDto> {
    return this.callService.start(sessionId, dto.peerId);
  }

  @Post('start')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiExcludeEndpoint()
  startRest(@Param('sessionId') sessionId: string, @Body() dto: StartCallDto): Promise<VoiceCallResponseDto> {
    return this.callService.start(sessionId, dto.peerId);
  }

  @Post(':callId/accept')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an incoming voice call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID' })
  @ApiResponse({ status: 200, type: CallActionResponseDto })
  @ApiResponse({ status: 400, description: 'Call cannot be accepted in its current state' })
  @ApiResponse({ status: 404, description: 'Session or call not found' })
  async accept(@Param('sessionId') sessionId: string, @Param('callId') callId: string): Promise<CallActionResponseDto> {
    await this.callService.accept(sessionId, callId);
    return { success: true };
  }

  @Post(':callId/reject')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject an incoming voice call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID' })
  @ApiResponse({ status: 200, type: CallActionResponseDto })
  @ApiResponse({ status: 400, description: 'Call cannot be rejected in its current state' })
  @ApiResponse({ status: 404, description: 'Session or call not found' })
  async reject(
    @Param('sessionId') sessionId: string,
    @Param('callId') callId: string,
    @Body() dto: RejectCallDto,
  ): Promise<CallActionResponseDto> {
    await this.callService.reject(sessionId, callId, dto.reason);
    return { success: true };
  }

  @Post(':callId/end')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a voice call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID' })
  @ApiResponse({ status: 200, type: CallActionResponseDto })
  @ApiResponse({ status: 400, description: 'Call has already ended' })
  @ApiResponse({ status: 404, description: 'Session or call not found' })
  async end(
    @Param('sessionId') sessionId: string,
    @Param('callId') callId: string,
    @Body() dto: EndCallDto,
  ): Promise<CallActionResponseDto> {
    await this.callService.end(sessionId, callId, dto.reason);
    return { success: true };
  }

  @Patch(':callId/mute')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute or unmute outgoing voice-call audio' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID' })
  @ApiResponse({ status: 200, type: CallActionResponseDto })
  @ApiResponse({ status: 400, description: 'Call has already ended' })
  @ApiResponse({ status: 404, description: 'Session or call not found' })
  async mute(
    @Param('sessionId') sessionId: string,
    @Param('callId') callId: string,
    @Body() dto: MuteCallDto,
  ): Promise<CallActionResponseDto> {
    await this.callService.mute(sessionId, callId, dto.muted);
    return { success: true };
  }
}
