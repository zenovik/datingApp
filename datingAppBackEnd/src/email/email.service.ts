import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<string>('SMTP_PORT');
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    if (!host || !port || !user || !pass) {
      this.logger.warn(
        'SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS are not fully set - emails will be logged instead of sent.',
      );
      return;
    }
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465,
      auth: { user, pass },
    });
  }

  /**
   * Best-effort, like NotificationsService.notify: never throws, so a down
   * SMTP server can never break the signup/reset flow that triggered it.
   */
  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(
        `[email not sent - SMTP not configured] to=${to} subject="${subject}"`,
      );
      return;
    }
    try {
      await this.transporter.sendMail({
        from:
          this.configService.get<string>('SMTP_FROM') ??
          'no-reply@lovefox.example',
        to,
        subject,
        html,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to send email to ${to}: ${(err as Error).message}`,
      );
    }
  }

  async sendWelcomeEmail(to: string, firstName: string): Promise<void> {
    await this.send(
      to,
      'Welcome to LoveFox!',
      `<p>Hi ${escapeHtml(firstName)},</p>
       <p>Welcome to LoveFox! Complete your profile and start swiping to find your match.</p>`,
    );
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.send(
      to,
      'Reset your LoveFox password',
      `<p>We received a request to reset your password.</p>
       <p><a href="${escapeHtml(resetUrl)}">Click here to reset your password</a>. This link expires in 1 hour.</p>
       <p>If you didn't request this, you can safely ignore this email.</p>`,
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
