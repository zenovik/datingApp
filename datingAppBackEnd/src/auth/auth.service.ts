import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { PASSWORD_SALT_ROUNDS, UsersService } from '../users/users.service';
import { UserResponseDto } from '../users/user-response.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { TwoFactorChallengeDto } from './dto/two-factor-challenge.dto';
import { TwoFactorSetupResponseDto } from './dto/two-factor-setup-response.dto';
import { AnalyticsService } from '../analytics/analytics.service';
import { EmailService } from '../email/email.service';
import type { User } from '@prisma/client';

interface AccessTokenPayload {
  sub: string;
  email: string;
}

const TWO_FACTOR_CHALLENGE_TTL = '5m';
const TWO_FACTOR_ISSUER = 'LoveFox';

interface TwoFactorChallengePayload {
  sub: string;
  purpose: 'two-factor-challenge';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly analytics: AnalyticsService,
    private readonly emailService: EmailService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const user = await this.usersService.create(dto);
    await this.analytics.track(user.id, 'SIGNUP');
    await this.emailService.sendWelcomeEmail(user.email, user.firstName);
    return this.issueTokens(user);
  }

  async validateUser(email: string, password: string): Promise<User> {
    const user = await this.usersService.findByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated');
    }
    return user;
  }

  async login(user: User): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    if (!user.twoFactorEnabled) {
      await this.analytics.track(user.id, 'LOGIN');
      return this.issueTokens(user);
    }

    const payload: TwoFactorChallengePayload = {
      sub: user.id,
      purpose: 'two-factor-challenge',
    };
    const challengeToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: TWO_FACTOR_CHALLENGE_TTL,
    });
    return { requiresTwoFactor: true, challengeToken };
  }

  async verifyTwoFactorLogin(
    challengeToken: string,
    code: string,
  ): Promise<AuthResponseDto> {
    let payload: TwoFactorChallengePayload;
    try {
      payload = await this.jwtService.verifyAsync<TwoFactorChallengePayload>(
        challengeToken,
        { secret: this.configService.get<string>('JWT_ACCESS_SECRET') },
      );
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired two-factor challenge',
      );
    }
    if (payload.purpose !== 'two-factor-challenge') {
      throw new UnauthorizedException('Invalid two-factor challenge');
    }

    const user = await this.usersService.findById(payload.sub);
    if (
      !user ||
      !user.isActive ||
      !user.twoFactorEnabled ||
      !user.twoFactorSecret
    ) {
      throw new UnauthorizedException(
        'Two-factor authentication is not available for this account',
      );
    }
    if (!authenticator.verify({ token: code, secret: user.twoFactorSecret })) {
      throw new UnauthorizedException('Invalid two-factor code');
    }

    await this.analytics.track(user.id, 'LOGIN');
    return this.issueTokens(user);
  }

  /** Generates a new secret and QR code. Not enabled until confirmTwoFactor() verifies a code. */
  async setupTwoFactor(userId: string): Promise<TwoFactorSetupResponseDto> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Account no longer available');
    }

    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret },
    });

    const otpauthUrl = authenticator.keyuri(
      user.email,
      TWO_FACTOR_ISSUER,
      secret,
    );
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    return { otpauthUrl, qrCodeDataUrl };
  }

  async confirmTwoFactor(userId: string, code: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user?.twoFactorSecret) {
      throw new BadRequestException('Call /auth/2fa/setup first');
    }
    if (!authenticator.verify({ token: code, secret: user.twoFactorSecret })) {
      throw new UnauthorizedException('Invalid two-factor code');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true },
    });
  }

  async disableTwoFactor(userId: string, password: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Incorrect password');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
  }

  async refresh(rawRefreshToken: string): Promise<AuthResponseDto> {
    let payload: { sub: string };
    try {
      payload = await this.jwtService.verifyAsync(rawRefreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt < new Date() ||
      stored.userId !== payload.sub
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.usersService.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account no longer available');
    }

    return this.issueTokens(user);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Always resolves the same way whether or not the email matches an
   * account, so this endpoint can't be used to enumerate registered emails.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + this.parseDurationMs('1h')),
      },
    });

    const resetUrl = `${this.configService.get<string>('FRONTEND_URL')}/reset-password?token=${rawToken}`;
    await this.emailService.sendPasswordResetEmail(user.email, resetUrl);
  }

  /**
   * Also revokes every active refresh token, so a stolen session can't
   * survive a password reset the account owner triggered to recover from it.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = this.hashToken(rawToken);
    const stored = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset link');
    }

    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: stored.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  private async issueTokens(user: User): Promise<AuthResponseDto> {
    const payload: AccessTokenPayload = { sub: user.id, email: user.email };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>(
        'JWT_ACCESS_EXPIRES_IN',
      ) as JwtSignOptions['expiresIn'],
    });

    const refreshExpiresIn = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
    )!;
    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id, jti: crypto.randomUUID() },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresIn as JwtSignOptions['expiresIn'],
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(
          Date.now() + this.parseDurationMs(refreshExpiresIn),
        ),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: UserResponseDto.fromEntity(user),
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) {
      throw new Error(`Invalid duration format: ${duration}`);
    }
    const value = Number(match[1]);
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2]
    ]!;
    return value * unitMs;
  }
}
