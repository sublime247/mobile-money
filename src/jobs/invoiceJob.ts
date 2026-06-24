import { pool } from '../config/database';
import { TransactionModel } from '../models/transaction';
import { UserModel } from '../models/users';
import { EmailService } from '../services/email';
import { InvoiceService } from '../services/invoiceService';
import logger from '../utils/logger';

export async function runMonthlyInvoiceJob() {
  const transactionModel = new TransactionModel();
  const userModel = new UserModel();
  const emailService = new EmailService();
  const invoiceService = new InvoiceService();

  // Determine previous month
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  logger.info(`Starting monthly invoice job for ${month}/${year}`);

  try {
    // 1. Fetch "Business Clients" (kyc_level = 'full' and email NOT NULL)
    // We use a direct query here to find candidates
    const businessUsersResult = await pool.query(`
      SELECT id FROM users 
      WHERE kyc_level = 'full' 
      AND email IS NOT NULL 
      AND status = 'active'
    `);

    const userIds = businessUsersResult.rows.map(r => r.id);
    logger.info(`Found ${userIds.length} potential business clients`);

    for (const userId of userIds) {
      try {
        const user = await userModel.findById(userId);
        if (!user || !user.email) continue;

        // 2. Fetch completed transactions for the previous month
        const transactions = await transactionModel.findCompletedByUserSince(userId, startDate);
        // Filter those that are BEFORE endDate (since findCompletedByUserSince only has 'since')
        const monthTransactions = transactions.filter(tx => tx.createdAt <= endDate);

        if (monthTransactions.length === 0) {
          logger.info(`No transactions for user ${userId} in ${month}/${year}, skipping invoice.`);
          continue;
        }

        // 3. Generate PDF
        const pdfBuffer = await invoiceService.generateMonthlyInvoicePDF(user, month, year, monthTransactions);

        // 4. Send Email
        await emailService.sendEmail({
          to: user.email,
          templateId: process.env.SENDGRID_INVOICE_TEMPLATE_ID || 'd-generic-invoice-template',
          dynamicTemplateData: {
            month: new Date(year, month - 1).toLocaleString('default', { month: 'long' }),
            year: year,
            name: user.phoneNumber, // We don't have first_name in User model yet
          },
          attachments: [
            {
              content: pdfBuffer.toString('base64'),
              filename: `Invoice_${month}_${year}.pdf`,
              type: 'application/pdf',
              disposition: 'attachment',
            }
          ]
        });

        logger.info(`Sent monthly invoice to user ${userId} (${user.email})`);
      } catch (err) {
        logger.error(err, `Failed to process invoice for user ${userId}`);
      }
    }

    logger.info('Monthly invoice job completed successfully');
  } catch (err) {
    logger.error(err, 'Monthly invoice job failed');
  }
}
