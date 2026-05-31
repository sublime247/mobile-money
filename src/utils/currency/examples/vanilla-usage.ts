/**
 * Vanilla JavaScript/TypeScript Example using CurrencyFormatter
 *
 * This example shows how to use CurrencyFormatter in plain JavaScript/TypeScript
 * without any framework dependencies.
 */

import { CurrencyFormatter, CurrencyConfig } from "../index";

// Example 1: Basic formatting
function formatCurrencyExample() {
  console.log("=== Basic Currency Formatting ===");

  // Format USD amount
  const usdFormatted = CurrencyFormatter.format(1234.56, "USD");
  console.log("USD 1234.56:", usdFormatted); // "$1,234.56"

  // Format XAF amount (0 decimal places)
  const xafFormatted = CurrencyFormatter.format(5000, "XAF");
  console.log("XAF 5000:", xafFormatted); // "5 000 FCFA"

  // Format GHS amount
  const ghsFormatted = CurrencyFormatter.format(99.99, "GHS");
  console.log("GHS 99.99:", ghsFormatted); // "GH₵99.99"

  // Format NGN amount
  const ngnFormatted = CurrencyFormatter.format(1000.5, "NGN");
  console.log("NGN 1000.50:", ngnFormatted); // "₦1,000.50"
}

// Example 2: Batch formatting for better performance
function batchFormattingExample() {
  console.log("\n=== Batch Formatting ===");

  const transactions = [
    { amount: 100, currency: "USD" },
    { amount: 5000, currency: "XAF" },
    { amount: 50.75, currency: "GHS" },
    { amount: 2500.25, currency: "NGN" },
  ];

  const formatted = CurrencyFormatter.formatBatch(transactions);

  transactions.forEach((tx, i) => {
    console.log(`${tx.currency} ${tx.amount}:`, formatted[i]);
  });
}

// Example 3: Custom formatting options
function customFormattingExample() {
  console.log("\n=== Custom Formatting Options ===");

  // Different locale
  const germanFormat = CurrencyFormatter.format(1234.56, "USD", {
    locale: "de-DE",
  });
  console.log("USD in German locale:", germanFormat); // "1.234,56 $"

  // No thousands grouping
  const noGrouping = CurrencyFormatter.format(1000000, "USD", {
    useGrouping: false,
  });
  console.log("No thousands grouping:", noGrouping); // "$1000000.00"

  // Custom decimal places
  const fourDecimals = CurrencyFormatter.format(100, "USD", {
    minimumFractionDigits: 4,
  });
  console.log("4 decimal places:", fourDecimals); // "$100.0000"

  // Different rounding modes
  const floorRound = CurrencyFormatter.format(1.999, "USD", {
    roundingMode: "floor",
  });
  const ceilRound = CurrencyFormatter.format(1.001, "USD", {
    roundingMode: "ceil",
  });
  console.log("Floor rounding:", floorRound); // "$1.99"
  console.log("Ceil rounding:", ceilRound); // "$1.01"
}

// Example 4: Error handling
function errorHandlingExample() {
  console.log("\n=== Error Handling ===");

  try {
    // Invalid amount
    CurrencyFormatter.format(NaN, "USD");
  } catch (error) {
    console.log("Invalid amount error:", error.message);
  }

  try {
    // Unsupported currency
    CurrencyFormatter.format(100, "EUR");
  } catch (error) {
    console.log("Unsupported currency error:", error.message);
  }

  // Graceful error handling with formatWithResult
  const result = CurrencyFormatter.formatWithResult(NaN, "USD");
  console.log("Format result:", {
    success: result.success,
    formatted: result.formatted,
    error: result.error,
  });
}

// Example 5: Configuration management
function configurationExample() {
  console.log("\n=== Configuration Management ===");

  // Get supported currencies
  const supported = CurrencyConfig.getSupportedCurrencies();
  console.log("Supported currencies:", supported);

  // Get currency information
  supported.forEach((currency) => {
    console.log(`${currency}:`, {
      symbol: CurrencyConfig.getCurrencySymbol(currency),
      name: CurrencyConfig.getCurrencyName(currency),
      locale: CurrencyConfig.getDefaultLocale(currency),
    });
  });

  // Update configuration at runtime
  try {
    CurrencyConfig.updateConfiguration([
      {
        code: "USD",
        formatting: {
          roundingMode: "floor",
          useGrouping: false,
          locale: "en-US",
          style: "currency",
        },
      },
    ]);

    const updatedFormat = CurrencyFormatter.format(1000.999, "USD");
    console.log("Updated USD format:", updatedFormat); // "$1000.99" (no commas, floor rounding)
  } catch (error) {
    console.log("Configuration update error:", error.message);
  }
}

// Example 6: Creating formatter instances
function formatterInstanceExample() {
  console.log("\n=== Formatter Instances ===");

  // Create a formatter instance with default currency
  const usdFormatter = new CurrencyFormatter("USD", "en-US");
  console.log("USD formatter:", usdFormatter.format(1234.56)); // "$1,234.56"

  // Create a formatter with German locale
  const germanFormatter = new CurrencyFormatter("USD", "de-DE");
  console.log("German formatter:", germanFormatter.format(1234.56)); // "1.234,56 $"

  // Instance with different default currency
  const xafFormatter = new CurrencyFormatter("XAF", "fr-CM");
  console.log("XAF formatter:", xafFormatter.format(5000)); // "5 000 FCFA"
}

// Example 7: Integration with DOM
function domIntegrationExample() {
  console.log("\n=== DOM Integration ===");

  // This would typically run in a browser environment
  // For demonstration, we'll simulate DOM operations

  const mockElements = {
    amountInput: { value: "1234.56" },
    currencySelect: { value: "USD" },
    localeSelect: { value: "en-US" },
    outputDiv: { textContent: "" },
  };

  // Simulate formatting on button click
  function formatButtonClick() {
    const amount = parseFloat(mockElements.amountInput.value);
    const currency = mockElements.currencySelect.value;
    const locale = mockElements.localeSelect.value;

    try {
      const formatted = CurrencyFormatter.format(amount, currency, { locale });
      mockElements.outputDiv.textContent = formatted;
      console.log("Formatted for display:", formatted);
    } catch (error) {
      mockElements.outputDiv.textContent = `Error: ${error.message}`;
      console.log("Formatting error:", error.message);
    }
  }

  // Simulate the click
  console.log("Simulating format button click...");
  formatButtonClick();
}

// Example 8: Performance considerations
function performanceExample() {
  console.log("\n=== Performance Considerations ===");

  // Measure single formatting operation
  const startSingle = performance.now();
  for (let i = 0; i < 1000; i++) {
    CurrencyFormatter.format(100 + i, "USD");
  }
  const endSingle = performance.now();
  console.log(`1000 single formats: ${(endSingle - startSingle).toFixed(2)}ms`);

  // Measure batch formatting
  const batchData = Array.from({ length: 1000 }, (_, i) => ({
    amount: 100 + i,
    currency: "USD",
  }));

  const startBatch = performance.now();
  CurrencyFormatter.formatBatch(batchData);
  const endBatch = performance.now();
  console.log(`1000 batch formats: ${(endBatch - startBatch).toFixed(2)}ms`);

  console.log(
    `Batch is ${((endSingle - startSingle) / (endBatch - startBatch)).toFixed(1)}x faster`,
  );
}

// Run all examples
function runAllExamples() {
  console.log("CurrencyFormatter Vanilla Usage Examples\n");
  console.log("========================================\n");

  formatCurrencyExample();
  batchFormattingExample();
  customFormattingExample();
  errorHandlingExample();
  configurationExample();
  formatterInstanceExample();
  domIntegrationExample();
  performanceExample();

  console.log("\n========================================");
  console.log("All examples completed successfully!");
}

// Export for use in other files
export {
  formatCurrencyExample,
  batchFormattingExample,
  customFormattingExample,
  errorHandlingExample,
  configurationExample,
  formatterInstanceExample,
  domIntegrationExample,
  performanceExample,
  runAllExamples,
};

// Run if this file is executed directly
if (typeof require !== "undefined" && require.main === module) {
  runAllExamples();
}
