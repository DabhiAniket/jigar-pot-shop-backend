import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/env';
import { logger } from './logger';

export interface Mailer {
  readonly enabled: boolean;
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/**
 * SMTP mailer for password-reset emails. Without SMTP_URL, self-service reset is unavailable
 * and super admins issue reset links from the admin panel instead. Links are never logged.
 */
export function createMailer(config: AppConfig): Mailer {
  if (!config.mail) {
    return {
      enabled: false,
      async send() {
        logger.info('email not sent: SMTP is not configured');
      },
    };
  }
  const transport = nodemailer.createTransport(config.mail.smtpUrl);
  const from = config.mail.from;
  return {
    enabled: true,
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}
