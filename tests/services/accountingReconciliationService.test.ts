import { AccountingChartOfAccountsReconciliationService } from "../../src/services/accountingReconciliation/service";
import { AccountingProvider } from "../../src/services/accounting";
import { AccountingDiscrepancyType } from "../../src/services/accountingReconciliation/model";

// Mock dependencies
jest.mock("../../src/services/ledgerService");
jest.mock("../../src/services/accounting");
jest.mock("../../src/services/accountingReconciliation/model");
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("axios");

describe("AccountingChartOfAccountsReconciliationService", () => {
  let service: AccountingChartOfAccountsReconciliationService;
  let mockLedgerService: any;
  let mockAccountingService: any;
  let mockReconModel: any;

  beforeEach(() => {
    service = new AccountingChartOfAccountsReconciliationService();
    mockLedgerService = (service as any).ledgerService;
    mockAccountingService = (service as any).accountingService;
    mockReconModel = (service as any).reconModel;
  });

  describe("runDailyReconciliation", () => {
    it("should correctly identify discrepancies", async () => {
      const reportDate = new Date("2026-05-30");
      const connectionId = "test-connection-id";
      const provider = AccountingProvider.QUICKBOOKS;

      mockReconModel.createReport.mockResolvedValue({ id: "report-1" });
      mockLedgerService.getTrialBalance.mockResolvedValue([
        {
          account_code: "1000",
          account_name: "Cash",
          account_type: "Asset",
          debit_balance: 100,
          credit_balance: 0,
        },
        {
          account_code: "2000",
          account_name: "Accounts Payable",
          account_type: "Liability",
          debit_balance: 0,
          credit_balance: 50,
        },
      ]);

      mockAccountingService.getConnection.mockResolvedValue({
        id: connectionId,
        realmId: "realm-1",
        accessToken: "token-1",
      });

      // Mock getQuickBooksChartOfAccounts through axios
      const axios = require("axios");
      axios.get.mockResolvedValue({
        data: {
          QueryResponse: {
            Account: [
              {
                Id: "1000",
                Name: "Cash (Modified)",
                AccountType: "Asset",
                CurrentBalance: "100",
              },
              {
                Id: "3000",
                Name: "New Account",
                AccountType: "Revenue",
                CurrentBalance: "200",
              },
            ],
          },
        },
      });

      await service.runDailyReconciliation(provider, connectionId, reportDate);

      expect(mockReconModel.createDiscrepancy).toHaveBeenCalled();
      
      // Should have:
      // 1. Name mismatch for 1000
      // 2. Missing in external for 2000
      // 3. Missing in internal for 3000
      
      const discrepancyTypes = mockReconModel.createDiscrepancy.mock.calls.map(call => call[0].type);
      expect(discrepancyTypes).toContain(AccountingDiscrepancyType.AccountNameMismatch);
      expect(discrepancyTypes).toContain(AccountingDiscrepancyType.AccountMissingInQBO);
      expect(discrepancyTypes).toContain(AccountingDiscrepancyType.AccountMissingInInternal);
    });
  });

  describe("exportReportToCSV", () => {
    it("should generate a valid CSV string", async () => {
      const reportId = "report-1";
      mockReconModel.getReportById.mockResolvedValue({
        id: reportId,
        provider: "quickbooks",
        reportDate: new Date(),
      });

      mockReconModel.getDiscrepanciesByReportId.mockResolvedValue([
        {
          type: AccountingDiscrepancyType.AccountNameMismatch,
          internalAccountCode: "1000",
          internalAccountName: "Cash",
          externalAccountName: "Cash (Modified)",
          reviewStatus: "pending",
        },
      ]);

      const csv = await service.exportReportToCSV(reportId);
      
      expect(csv).toContain("Type,Internal Code,Internal Name");
      expect(csv).toContain("account_name_mismatch");
      expect(csv).toContain("1000");
      expect(csv).toContain("Cash");
      expect(csv).toContain("Cash (Modified)");
    });
  });
});
