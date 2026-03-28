// scripts/testEmail.ts
import { EmailService } from "../services/email";

const emailService = new EmailService();

const mockTransaction = {
    id: "tx-123",
    referenceNumber: "REF-123",
    type: "deposit",
    amount: "100.00",
    phoneNumber: "+1234567890",
    provider: "mtn",
    stellarAddress: "GABC...",
    status: "completed",
    createdAt: new Date(),
} as any;

async function run() {
    await emailService.sendTransactionReceipt(
        "", 
        mockTransaction
    );

    console.log("Email sent!");
}

run();