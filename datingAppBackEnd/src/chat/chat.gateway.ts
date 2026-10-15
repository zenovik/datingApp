import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from './presence.service';
import { MessagesService } from './messages.service';
import { CallsService } from './calls.service';
import { WsHttpExceptionFilter } from './ws-http-exception.filter';
import { SendMessageDto } from './dto/send-message.dto';
import { TypingDto } from './dto/typing.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { MessageIdDto } from './dto/message-id.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { CallInviteDto } from './dto/call-invite.dto';
import { CallIdDto } from './dto/call-id.dto';
import { WebrtcIceCandidateDto, WebrtcSdpDto } from './dto/webrtc-signal.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';

interface AuthedSocket extends Socket {
  data: { userId: string };
}

@WebSocketGateway({
  namespace: '/chat',
  // Mirrors main.ts's HTTP CORS setup. This was previously hardcoded to the
  // dev-only regex below in every environment - engine.io validates Origin
  // server-side on the initial handshake regardless of transport, so in
  // production (any real deployed frontend origin, e.g. on Hostinger) every
  // socket connection was being rejected before the app-level code ever ran,
  // silently breaking chat and call signaling. In dev, reflects localhost or
  // any LAN IP on port 4200 so chat/calls also work when the frontend is
  // opened from a phone on the same network.
  cors: {
    origin:
      process.env.NODE_ENV === 'production'
        ? process.env.FRONTEND_URL
        : /^http:\/\/(localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):4200$/,
    credentials: true,
  },
})
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
@UseFilters(WsHttpExceptionFilter)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  // Socket.io clears socket.rooms before the 'disconnect' event fires, so we
  // can't rely on it in handleDisconnect to know which conversation rooms to
  // notify. Track it ourselves per socket instead.
  private readonly conversationIdsBySocket = new Map<string, string[]>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly messagesService: MessagesService,
    private readonly callsService: CallsService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async handleConnection(client: AuthedSocket): Promise<void> {
    const token = (client.handshake.auth?.token ??
      client.handshake.query?.token) as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }

    let userId: string;
    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(
        token,
        {
          secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
        },
      );
      userId = payload.sub;
    } catch {
      client.disconnect(true);
      return;
    }

    client.data.userId = userId;

    const conversations = await this.prisma.conversation.findMany({
      where: { match: { OR: [{ userAId: userId }, { userBId: userId }] } },
      include: { match: true },
    });

    await client.join(`user:${userId}`);
    for (const conversation of conversations) {
      await client.join(`conversation:${conversation.id}`);
    }
    this.conversationIdsBySocket.set(
      client.id,
      conversations.map((c) => c.id),
    );

    const wasOffline = this.presence.addConnection(userId, client.id);
    if (wasOffline && !(await this.hidesOnlineStatus(userId))) {
      for (const conversation of conversations) {
        this.server
          .to(`conversation:${conversation.id}`)
          .emit('presence', { userId, online: true });
      }
    }
  }

  async handleDisconnect(client: AuthedSocket): Promise<void> {
    const userId = client.data?.userId;
    const conversationIds = this.conversationIdsBySocket.get(client.id) ?? [];
    this.conversationIdsBySocket.delete(client.id);
    if (!userId) return;

    const nowOffline = this.presence.removeConnection(userId, client.id);
    if (nowOffline) {
      if (!(await this.hidesOnlineStatus(userId))) {
        for (const conversationId of conversationIds) {
          this.server
            .to(`conversation:${conversationId}`)
            .emit('presence', { userId, online: false });
        }
      }

      // Closing the tab / losing network mid-ring or mid-call otherwise left
      // the call stuck RINGING/ACTIVE forever with nothing to ever end it -
      // see the comment on CallsService.endCallsForDisconnectedUser.
      const endedCalls =
        await this.callsService.endCallsForDisconnectedUser(userId);
      for (const { callId, otherUserId, status } of endedCalls) {
        this.server
          .to(`user:${otherUserId}`)
          .emit('callEnded', { callId, status });
      }
    }
  }

  /**
   * handleConnection only joins a socket to the conversation rooms that
   * existed *at connect time* - a brand new match created afterwards (the
   * common case: you're already logged in with the app open, then you
   * match with someone) never gets its room joined for either side's
   * already-open socket, so `server.to(conversation:id).emit(...)` silently
   * reaches nobody and messages only show up after a reload reconnects the
   * socket and re-runs handleConnection. Called right after a match +
   * conversation is created so both sides' live sockets (if any - either
   * user may not be online right now) start receiving it immediately.
   */
  joinConversationRoom(conversationId: string, userIds: string[]): void {
    const room = `conversation:${conversationId}`;
    for (const userId of userIds) {
      for (const socketId of this.presence.getSocketIds(userId)) {
        void this.server.in(socketId).socketsJoin(room);
      }
    }
  }

  /** Profile.hideOnlineStatus opts a user out of the visible green-dot broadcast (presence is still tracked internally for delivery receipts). */
  private async hidesOnlineStatus(userId: string): Promise<boolean> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { hideOnlineStatus: true },
    });
    return profile?.hideOnlineStatus ?? false;
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: SendMessageDto,
  ) {
    const message = await this.messagesService.sendMessage(
      client.data.userId,
      dto,
    );
    this.server
      .to(`conversation:${dto.conversationId}`)
      .emit('newMessage', message);
    await this.notifyOtherParticipant(client.data.userId, message);
    await this.analytics.track(client.data.userId, 'MESSAGE_SENT');
    return message;
  }

  /**
   * Only pushes to the other side of the conversation, and only if they
   * don't already have a live socket connected - they'll see it arrive over
   * the socket instead (see 'newMessage' emit above).
   */
  private async notifyOtherParticipant(
    senderId: string,
    message: { conversationId: string; type: string; content: string | null },
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: message.conversationId },
      include: { match: true },
    });
    if (!conversation) return;

    const recipientId =
      conversation.match.userAId === senderId
        ? conversation.match.userBId
        : conversation.match.userAId;
    if (this.presence.isOnline(recipientId)) return;

    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { firstName: true },
    });
    const preview =
      message.type === 'IMAGE'
        ? 'Sent a photo'
        : message.type === 'VOICE'
          ? 'Sent a voice message'
          : (message.content ?? '');

    await this.notifications.notify(recipientId, {
      title: sender?.firstName ?? 'New message',
      body: preview,
      url: '/chating/' + senderId,
    });
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: TypingDto,
  ): void {
    client.to(`conversation:${dto.conversationId}`).emit('typing', {
      conversationId: dto.conversationId,
      userId: client.data.userId,
      isTyping: dto.isTyping,
    });
  }

  @SubscribeMessage('markRead')
  async handleMarkRead(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: MarkReadDto,
  ) {
    const readMessageIds = await this.messagesService.markRead(
      client.data.userId,
      dto.conversationId,
      dto.upToMessageId,
    );
    this.server.to(`conversation:${dto.conversationId}`).emit('messagesRead', {
      conversationId: dto.conversationId,
      readerId: client.data.userId,
      messageIds: readMessageIds,
    });
    return { messageIds: readMessageIds };
  }

  @SubscribeMessage('deleteMessage')
  async handleDeleteMessage(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: MessageIdDto,
  ) {
    const { conversationId } = await this.messagesService.deleteMessage(
      client.data.userId,
      dto.messageId,
    );
    this.server
      .to(`conversation:${conversationId}`)
      .emit('messageDeleted', { messageId: dto.messageId, conversationId });
    return { messageId: dto.messageId };
  }

  @SubscribeMessage('reactToMessage')
  async handleReact(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: ReactMessageDto,
  ) {
    const { conversationId, added } = await this.messagesService.reactToMessage(
      client.data.userId,
      dto.messageId,
      dto.emoji,
    );
    this.server.to(`conversation:${conversationId}`).emit('messageReaction', {
      messageId: dto.messageId,
      userId: client.data.userId,
      emoji: dto.emoji,
      added,
    });
    return { added };
  }

  @SubscribeMessage('callInvite')
  async handleCallInvite(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: CallInviteDto,
  ) {
    const { call, calleeId } = await this.callsService.inviteCall(
      client.data.userId,
      dto.conversationId,
      dto.type,
    );
    const caller = await this.prisma.user.findUnique({
      where: { id: client.data.userId },
      select: { firstName: true },
    });

    this.server.to(`user:${calleeId}`).emit('incomingCall', {
      callId: call.id,
      conversationId: call.conversationId,
      callerId: client.data.userId,
      callerFirstName: caller?.firstName ?? '',
      type: call.type,
    });
    return { callId: call.id };
  }

  @SubscribeMessage('callAccept')
  async handleCallAccept(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: CallIdDto,
  ) {
    const { call, otherUserId } = await this.callsService.acceptCall(
      client.data.userId,
      dto.callId,
    );
    this.server
      .to(`user:${otherUserId}`)
      .emit('callAccepted', { callId: call.id });
    return { callId: call.id };
  }

  @SubscribeMessage('callDecline')
  async handleCallDecline(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: CallIdDto,
  ) {
    const { call, otherUserId } = await this.callsService.declineCall(
      client.data.userId,
      dto.callId,
    );
    this.server
      .to(`user:${otherUserId}`)
      .emit('callDeclined', { callId: call.id });
    return { callId: call.id };
  }

  @SubscribeMessage('callEnd')
  async handleCallEnd(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: CallIdDto,
  ) {
    const { call, otherUserId } = await this.callsService.endCall(
      client.data.userId,
      dto.callId,
    );
    this.server
      .to(`user:${otherUserId}`)
      .emit('callEnded', { callId: call.id, status: call.status });
    return { callId: call.id, status: call.status };
  }

  @SubscribeMessage('webrtcOffer')
  async handleWebrtcOffer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: WebrtcSdpDto,
  ) {
    const target = await this.callsService.relayTargetFor(
      dto.callId,
      client.data.userId,
    );
    this.server.to(`user:${target}`).emit('webrtcOffer', {
      callId: dto.callId,
      sdp: dto.sdp,
      from: client.data.userId,
    });
  }

  @SubscribeMessage('webrtcAnswer')
  async handleWebrtcAnswer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: WebrtcSdpDto,
  ) {
    const target = await this.callsService.relayTargetFor(
      dto.callId,
      client.data.userId,
    );
    this.server.to(`user:${target}`).emit('webrtcAnswer', {
      callId: dto.callId,
      sdp: dto.sdp,
      from: client.data.userId,
    });
  }

  @SubscribeMessage('webrtcIceCandidate')
  async handleWebrtcIceCandidate(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() dto: WebrtcIceCandidateDto,
  ) {
    const target = await this.callsService.relayTargetFor(
      dto.callId,
      client.data.userId,
    );
    this.server.to(`user:${target}`).emit('webrtcIceCandidate', {
      callId: dto.callId,
      candidate: dto.candidate,
      from: client.data.userId,
    });
  }
}
