import PDFDocument from 'pdfkit';
import { Transaction } from '../models/transaction';
import { User } from '../models/users';
import { maskPhoneNumber, maskStellarAddress } from '../utils/masking';
import { currencyService } from './currency';

export class InvoiceService {
  async generateMonthlyInvoicePDF(
    user: User,
    month: number,
    year: number,
    transactions: Transaction[]
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      // Header - Branding
      doc
        .fillColor('#444444')
        .fontSize(20)
        .text('OPULENCE MOBILE MONEY', 50, 45)
        .fontSize(10)
        .text('Branded Monthly Invoice', 50, 70)
        .text('Opulence Financial Services Ltd.', 200, 45, { align: 'right' })
        .text('123 Finance Plaza, Douala, Cameroon', 200, 60, { align: 'right' })
        .text('https://mobilemoney.opulence.com', 200, 75, { align: 'right' })
        .moveDown();

      // Horizontal Line
      doc.moveTo(50, 100).lineTo(550, 100).stroke();

      // Invoice Info
      const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });
      doc
        .fontSize(12)
        .text(`Billing Period: ${monthName} ${year}`, 50, 120)
        .text(`Invoice Date: ${new Date().toLocaleDateString()}`, 50, 135)
        .text(`Client ID: ${user.id.slice(0, 8)}`, 50, 150);

      // Customer Info
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('BILL TO:', 350, 120)
        .font('Helvetica')
        .text(user.phoneNumber ? maskPhoneNumber(user.phoneNumber) : 'N/A', 350, 135)
        .text(user.email || 'N/A', 350, 150)
        .moveDown(2);

      // Summary Table Header
      doc
        .fontSize(14)
        .text('Monthly Summary by Currency', 50, 200)
        .moveDown();

      // Group transactions by currency
      const currencyGroups: Record<string, {
        deposits: number;
        withdrawals: number;
        fees: number;
        total: number;
        count: number;
      }> = {};

      transactions.forEach(tx => {
        const currency = tx.currency || 'USD';
        if (!currencyGroups[currency]) {
          currencyGroups[currency] = { deposits: 0, withdrawals: 0, fees: 0, total: 0, count: 0 };
        }
        
        const amount = parseFloat(tx.amount);
        const fee = tx.fee ? parseFloat(tx.fee) : 0;
        
        currencyGroups[currency].count++;
        currencyGroups[currency].fees += fee;
        
        if (tx.type === 'deposit') {
          currencyGroups[currency].deposits += amount;
          currencyGroups[currency].total += amount;
        } else {
          currencyGroups[currency].withdrawals += amount;
          currencyGroups[currency].total -= amount;
        }
      });

      // Render Summary Table
      let y = 230;
      doc.fontSize(10).fillColor('#444444');
      doc.font('Helvetica-Bold');
      doc.text('Currency', 50, y);
      doc.text('Deposits', 150, y);
      doc.text('Withdrawals', 250, y);
      doc.text('Fees', 350, y);
      doc.text('Net Total', 450, y);
      doc.font('Helvetica');
      y += 20;
      doc.moveTo(50, y - 5).lineTo(550, y - 5).stroke();

      Object.entries(currencyGroups).forEach(([currency, stats]) => {
        doc.text(currency, 50, y);
        doc.text(stats.deposits.toFixed(2), 150, y);
        doc.text(stats.withdrawals.toFixed(2), 250, y);
        doc.text(stats.fees.toFixed(2), 350, y);
        doc.text(stats.total.toFixed(2), 450, y);
        y += 20;
      });

      // Transaction List
      if (y > 650) {
        doc.addPage();
        y = 50;
      } else {
        y += 30;
      }

      doc
        .fontSize(14)
        .text('Detailed Transaction List', 50, y)
        .moveDown();
      
      y += 25;
      doc.fontSize(8);
      doc.font('Helvetica-Bold');
      doc.text('Date', 50, y);
      doc.text('Type', 120, y);
      doc.text('Amount', 180, y);
      doc.text('Fee', 250, y);
      doc.text('Provider', 300, y);
      doc.text('Reference', 380, y);
      doc.font('Helvetica');
      
      y += 15;
      doc.moveTo(50, y - 2).lineTo(550, y - 2).stroke();

      transactions.slice(0, 50).forEach(tx => { // Limit to 50 for now
        if (y > 730) {
          doc.addPage();
          y = 50;
        }
        doc.text(new Date(tx.createdAt).toLocaleDateString(), 50, y);
        doc.text(tx.type.toUpperCase(), 120, y);
        doc.text(`${tx.amount} ${tx.currency || 'USD'}`, 180, y);
        doc.text(tx.fee || '0.00', 250, y);
        doc.text(tx.provider.toUpperCase(), 300, y);
        doc.text(tx.referenceNumber, 380, y);
        y += 15;
      });

      if (transactions.length > 50) {
        doc.font('Helvetica-Oblique').text(`... and ${transactions.length - 50} more transactions.`, 50, y);
        doc.font('Helvetica');
      }

      // Footer
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .fillColor('#888888')
          .text(
            'Thank you for using Opulence Mobile Money. This is a computer-generated document.',
            50,
            750,
            { align: 'center', width: 500 }
          );
      }

      doc.end();
    });
  }
}
