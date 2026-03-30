import 'dotenv/config';
import express, { Request, Response } from 'express';
import { receive } from 'ingestion-module';
import * as communication from 'communication-module';
import { handleTeacherMessage, handleFeeInit, handleFeeReminders } from './handler';

const PORT         = parseInt(process.env['PORT'] ?? '3003', 10);
const VERIFY_TOKEN = process.env['WEBHOOK_VERIFY_TOKEN'] ?? '';

// ---------------------------------------------------------------------------
// Startup notification
// ---------------------------------------------------------------------------

async function sendStartupNotification(): Promise<void> {
  const teacherPhone = process.env['TUITION_TEACHER_PHONE'];
  const centerName = process.env['TUITION_CENTER_NAME'] ?? 'Tuition Center';
  
  if (!teacherPhone) {
    console.log('[tuition] No teacher phone configured, skipping startup notification');
    return;
  }

  try {
    const message = `🚀 ${centerName} System Started!\n\n` +
      `✅ Server is running on port ${PORT}\n` +
      `✅ Webhook is ready for messages\n` +
      `✅ Automated reminders are scheduled\n\n` +
      `You can now send commands like:\n` +
      `• present +919999999999\n` +
      `• paid +919999999999 500\n` +
      `• fees +919999999999\n\n` +
      `System is ready! 📚`;

    await communication.execute({ 
      to: teacherPhone, 
      message: message 
    });
    
    console.log(`[tuition] Startup notification sent to ${teacherPhone}`);
  } catch (err) {
    console.error('[tuition] Failed to send startup notification:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Cron: monthly fee initialization — 1st of month at 08:00
// ---------------------------------------------------------------------------

function scheduleMonthlyFeeInit(): void {
  function msUntilNext1stAt8am(): number {
    const now  = new Date();
    const next = new Date(now);
    next.setDate(1);
    next.setHours(8, 0, 0, 0);
    // If 1st is in the past this month, advance to next month
    if (next <= now) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(8, 0, 0, 0);
    }
    return next.getTime() - now.getTime();
  }

  function scheduleNext(): void {
    const delay = msUntilNext1stAt8am();
    console.log(`[tuition] Next fee-init in ${Math.round(delay / 60000)}m`);
    setTimeout(async () => {
      await handleFeeInit().catch((err: unknown) => {
        console.error('[tuition] Cron fee-init error:', err instanceof Error ? err.message : err);
      });
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ---------------------------------------------------------------------------
// Cron: daily fee reminders at 09:00
// ---------------------------------------------------------------------------

function scheduleDailyReminders(): void {
  function msUntilNext9am(): number {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function scheduleNext(): void {
    const delay = msUntilNext9am();
    console.log(`[tuition] Next reminder in ${Math.round(delay / 60000)}m`);
    setTimeout(async () => {
      await handleFeeReminders().catch((err: unknown) => {
        console.error('[tuition] Cron reminder error:', err instanceof Error ? err.message : err);
      });
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ── GET /webhook — Meta webhook verification ──────────────────────────────

app.get('/webhook', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[tuition] Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[tuition] Webhook verification failed');
    res.sendStatus(403);
  }
});

// ── POST /webhook — Incoming WhatsApp messages ────────────────────────────

app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });

      if (!result.ok) {
        if (result.reason === 'status_update') return;
        console.log('[tuition] Skipping:', result.reason);
        return;
      }

      const { userId, message } = result.event;
      if (!message) { console.log('[tuition] Non-text event from', userId); return; }

      console.log('[tuition] Inbound from', userId);
      await handleTeacherMessage({ phone_number: userId, text_body: message, message_type: 'text' });
    } catch (err) {
      console.error('[tuition] Webhook error:', err instanceof Error ? err.message : err);
    }
  });
});

// ── POST /run/fee-init — Manual trigger for monthly fee initialization ────

app.post('/run/fee-init', (_req: Request, res: Response) => {
  res.json({ status: 'triggered' });

  setImmediate(async () => {
    await handleFeeInit().catch((err: unknown) => {
      console.error('[tuition] Manual fee-init error:', err instanceof Error ? err.message : err);
    });
  });
});

// ── POST /run/reminders — Manual trigger for fee reminders ───────────────

app.post('/run/reminders', (_req: Request, res: Response) => {
  res.json({ status: 'triggered' });

  setImmediate(async () => {
    await handleFeeReminders().catch((err: unknown) => {
      console.error('[tuition] Manual reminder error:', err instanceof Error ? err.message : err);
    });
  });
});

// ── GET /health ───────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', app: 'tuition-center' });
});

// ── GET /privacy-policy ───────────────────────────────────────────────────

app.get('/privacy-policy', (_req: Request, res: Response) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy - BRILLIANT ACADEMY</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
        h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        h2 { color: #555; margin-top: 30px; }
        .last-updated { color: #666; font-style: italic; }
        .contact { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 30px; }
    </style>
</head>
<body>
    <h1>Privacy Policy</h1>
    <p class="last-updated">Last updated: ${new Date().toLocaleDateString()}</p>
    
    <h2>1. Information We Collect</h2>
    <p>BRILLIANT ACADEMY ("we," "our," or "us") collects the following information to provide tuition center management services:</p>
    <ul>
        <li><strong>Student Information:</strong> Names, phone numbers, grades, and academic status</li>
        <li><strong>Attendance Data:</strong> Daily attendance records and class participation</li>
        <li><strong>Payment Information:</strong> Fee payment records and transaction history</li>
        <li><strong>Communication Data:</strong> WhatsApp messages for attendance marking and fee notifications</li>
    </ul>

    <h2>2. How We Use Your Information</h2>
    <p>We use the collected information for:</p>
    <ul>
        <li>Managing student attendance and academic records</li>
        <li>Processing fee payments and sending payment reminders</li>
        <li>Communicating with students and parents via WhatsApp</li>
        <li>Generating reports for academic and administrative purposes</li>
        <li>Improving our educational services</li>
    </ul>

    <h2>3. Information Sharing</h2>
    <p>We do not sell, trade, or share your personal information with third parties except:</p>
    <ul>
        <li>With your explicit consent</li>
        <li>To comply with legal requirements</li>
        <li>To protect our rights and safety</li>
        <li>With service providers who assist in our operations (Google Sheets for data storage, WhatsApp for communication)</li>
    </ul>

    <h2>4. Data Security</h2>
    <p>We implement appropriate security measures to protect your information:</p>
    <ul>
        <li>Encrypted data transmission and storage</li>
        <li>Access controls and authentication</li>
        <li>Regular security updates and monitoring</li>
        <li>Limited access to authorized personnel only</li>
    </ul>

    <h2>5. Data Retention</h2>
    <p>We retain your information for as long as necessary to provide our services and comply with legal obligations. Student records are typically maintained for the duration of enrollment plus additional time as required by educational regulations.</p>

    <h2>6. Your Rights</h2>
    <p>You have the right to:</p>
    <ul>
        <li>Access your personal information</li>
        <li>Request corrections to inaccurate data</li>
        <li>Request deletion of your information (subject to legal requirements)</li>
        <li>Opt-out of non-essential communications</li>
    </ul>

    <h2>7. Third-Party Services</h2>
    <p>Our service integrates with:</p>
    <ul>
        <li><strong>WhatsApp Business API:</strong> For communication and notifications</li>
        <li><strong>Google Sheets:</strong> For data storage and management</li>
        <li><strong>NVIDIA AI Services:</strong> For intelligent message processing</li>
    </ul>
    <p>These services have their own privacy policies, which we encourage you to review.</p>

    <h2>8. Children's Privacy</h2>
    <p>Our services are designed for educational institutions. We collect information about students under 18 only with parental consent and in accordance with educational privacy laws.</p>

    <h2>9. Changes to This Policy</h2>
    <p>We may update this privacy policy from time to time. We will notify users of any material changes via WhatsApp or email.</p>

    <div class="contact">
        <h2>10. Contact Us</h2>
        <p>If you have questions about this privacy policy, please contact us:</p>
        <p><strong>BRILLIANT ACADEMY</strong><br>
        Phone: +91 966 485 0215<br>
        Email: support@brilliantacademy.com</p>
    </div>
</body>
</html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ── GET /terms-of-service ─────────────────────────────────────────────────

app.get('/terms-of-service', (_req: Request, res: Response) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms of Service - BRILLIANT ACADEMY</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
        h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        h2 { color: #555; margin-top: 30px; }
        .last-updated { color: #666; font-style: italic; }
        .contact { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 30px; }
    </style>
</head>
<body>
    <h1>Terms of Service</h1>
    <p class="last-updated">Last updated: ${new Date().toLocaleDateString()}</p>
    
    <h2>1. Acceptance of Terms</h2>
    <p>By using BRILLIANT ACADEMY's tuition management services, you agree to these Terms of Service. If you do not agree, please do not use our services.</p>

    <h2>2. Description of Service</h2>
    <p>BRILLIANT ACADEMY provides:</p>
    <ul>
        <li>Student attendance tracking via WhatsApp</li>
        <li>Fee payment management and reminders</li>
        <li>Academic record management</li>
        <li>Automated communication services</li>
    </ul>

    <h2>3. User Responsibilities</h2>
    <p>Users agree to:</p>
    <ul>
        <li>Provide accurate and current information</li>
        <li>Use the service only for legitimate educational purposes</li>
        <li>Maintain the confidentiality of their account information</li>
        <li>Comply with all applicable laws and regulations</li>
        <li>Not misuse or abuse the communication features</li>
    </ul>

    <h2>4. Payment Terms</h2>
    <ul>
        <li>Tuition fees are due as specified in your enrollment agreement</li>
        <li>Late payments may result in service suspension</li>
        <li>Refunds are subject to our refund policy</li>
        <li>Fee reminders are sent as a courtesy; students remain responsible for timely payment</li>
    </ul>

    <h2>5. Communication Policy</h2>
    <ul>
        <li>We use WhatsApp for official communications</li>
        <li>Users consent to receive automated messages</li>
        <li>Users may opt-out of non-essential communications</li>
        <li>Misuse of communication features may result in service termination</li>
    </ul>

    <h2>6. Data Usage and Privacy</h2>
    <p>Your use of our services is also governed by our Privacy Policy. We collect and use information as described in our Privacy Policy to provide and improve our services.</p>

    <h2>7. Service Availability</h2>
    <ul>
        <li>We strive for 99% uptime but cannot guarantee uninterrupted service</li>
        <li>Scheduled maintenance will be announced in advance when possible</li>
        <li>We are not liable for service interruptions beyond our control</li>
    </ul>

    <h2>8. Intellectual Property</h2>
    <p>All content, features, and functionality of our service are owned by BRILLIANT ACADEMY and protected by copyright and other intellectual property laws.</p>

    <h2>9. Limitation of Liability</h2>
    <p>BRILLIANT ACADEMY shall not be liable for any indirect, incidental, special, or consequential damages arising from the use of our services.</p>

    <h2>10. Termination</h2>
    <p>We may terminate or suspend access to our services at any time for violations of these terms or for any other reason at our sole discretion.</p>

    <h2>11. Changes to Terms</h2>
    <p>We reserve the right to modify these terms at any time. Users will be notified of material changes via WhatsApp or email.</p>

    <h2>12. Governing Law</h2>
    <p>These terms are governed by the laws of India. Any disputes will be resolved in the courts of [Your City/State].</p>

    <div class="contact">
        <h2>13. Contact Information</h2>
        <p>For questions about these Terms of Service, contact us:</p>
        <p><strong>BRILLIANT ACADEMY</strong><br>
        Phone: +91 966 485 0215<br>
        Email: support@brilliantacademy.com</p>
    </div>
</body>
</html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`[tuition] Running on port ${PORT}`);
  scheduleMonthlyFeeInit();
  scheduleDailyReminders();
  
  // Send startup notification to teacher
  setTimeout(() => {
    sendStartupNotification().catch((err: unknown) => {
      console.error('[tuition] Startup notification error:', err instanceof Error ? err.message : err);
    });
  }, 2000); // Wait 2 seconds for server to fully initialize
});
