import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';

@Injectable()
export class ContactService {
  constructor(
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Best-effort, like every other EmailService call site - a down SMTP
   * server (or one that was never configured in this environment) must
   * never turn a visitor's contact-form submission into a 500.
   */
  async submit(dto: CreateContactMessageDto): Promise<void> {
    const supportEmail =
      this.configService.get<string>('SUPPORT_EMAIL') ??
      'support@lovefox.example';

    await this.emailService.send(
      supportEmail,
      `[Contact form] ${dto.subject}`,
      `<p><b>From:</b> ${escapeHtml(dto.name)} &lt;${escapeHtml(dto.email)}&gt;</p>
       <p><b>Subject:</b> ${escapeHtml(dto.subject)}</p>
       <p>${escapeHtml(dto.message).replace(/\n/g, '<br>')}</p>`,
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
