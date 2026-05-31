/**
 * React Component Example using CurrencyFormatter
 *
 * This example shows how to use CurrencyFormatter in a React component
 */

import React, { useState, useEffect } from "react";
import { CurrencyFormatter, CurrencyConfig } from "../index";

interface CurrencyDisplayProps {
  amount: number;
  currency: string;
  locale?: string;
  showSymbol?: boolean;
}

const CurrencyDisplay: React.FC<CurrencyDisplayProps> = ({
  amount,
  currency,
  locale,
  showSymbol = true,
}) => {
  const [formattedAmount, setFormattedAmount] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      // Format the amount using CurrencyFormatter
      const formatted = CurrencyFormatter.format(amount, currency, {
        locale,
        useGrouping: true,
      });
      setFormattedAmount(formatted);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Formatting error");
      setFormattedAmount("");
    }
  }, [amount, currency, locale]);

  if (error) {
    return <div className="currency-error">Error: {error}</div>;
  }

  return (
    <div className="currency-display">
      {showSymbol && (
        <span className="currency-symbol">
          {CurrencyConfig.getCurrencySymbol(currency)}
        </span>
      )}
      <span className="currency-amount">{formattedAmount}</span>
      <span className="currency-code">({currency})</span>
    </div>
  );
};

interface CurrencyConverterProps {
  baseAmount: number;
  baseCurrency: string;
  targetCurrency: string;
  exchangeRate: number;
}

const CurrencyConverter: React.FC<CurrencyConverterProps> = ({
  baseAmount,
  baseCurrency,
  targetCurrency,
  exchangeRate,
}) => {
  const [convertedAmount, setConvertedAmount] = useState<number>(0);

  useEffect(() => {
    // Calculate converted amount
    const amount = baseAmount * exchangeRate;
    setConvertedAmount(amount);
  }, [baseAmount, exchangeRate]);

  return (
    <div className="currency-converter">
      <div className="original-amount">
        <CurrencyDisplay amount={baseAmount} currency={baseCurrency} />
      </div>
      <div className="conversion-arrow">→</div>
      <div className="converted-amount">
        <CurrencyDisplay amount={convertedAmount} currency={targetCurrency} />
      </div>
      <div className="exchange-rate">
        Rate: 1 {baseCurrency} = {exchangeRate.toFixed(4)} {targetCurrency}
      </div>
    </div>
  );
};

interface BatchCurrencyFormatterProps {
  transactions: Array<{
    id: string;
    amount: number;
    currency: string;
    description: string;
  }>;
}

const BatchCurrencyFormatter: React.FC<BatchCurrencyFormatterProps> = ({
  transactions,
}) => {
  const [formattedTransactions, setFormattedTransactions] = useState<string[]>(
    [],
  );

  useEffect(() => {
    try {
      // Use batch formatting for better performance
      const amounts = transactions.map((t) => ({
        amount: t.amount,
        currency: t.currency,
      }));
      const formatted = CurrencyFormatter.formatBatch(amounts);
      setFormattedTransactions(formatted);
    } catch (err) {
      console.error("Batch formatting failed:", err);
    }
  }, [transactions]);

  return (
    <div className="batch-currency-formatter">
      <h3>Transaction Summary</h3>
      <ul>
        {transactions.map((transaction, index) => (
          <li key={transaction.id} className="transaction-item">
            <span className="transaction-description">
              {transaction.description}:
            </span>
            <span className="transaction-amount">
              {formattedTransactions[index] || "Formatting..."}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

interface CurrencySettingsProps {
  onCurrencyChange: (currency: string) => void;
  onLocaleChange: (locale: string) => void;
}

const CurrencySettings: React.FC<CurrencySettingsProps> = ({
  onCurrencyChange,
  onLocaleChange,
}) => {
  const supportedCurrencies = CurrencyConfig.getSupportedCurrencies();
  const [selectedCurrency, setSelectedCurrency] = useState<string>("USD");
  const [selectedLocale, setSelectedLocale] = useState<string>("en-US");

  const handleCurrencyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const currency = e.target.value;
    setSelectedCurrency(currency);
    onCurrencyChange(currency);
  };

  const handleLocaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const locale = e.target.value;
    setSelectedLocale(locale);
    onLocaleChange(locale);
  };

  return (
    <div className="currency-settings">
      <div className="setting-group">
        <label htmlFor="currency-select">Currency:</label>
        <select
          id="currency-select"
          value={selectedCurrency}
          onChange={handleCurrencyChange}
        >
          {supportedCurrencies.map((currency) => (
            <option key={currency} value={currency}>
              {currency} - {CurrencyConfig.getCurrencyName(currency)}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-group">
        <label htmlFor="locale-select">Locale:</label>
        <select
          id="locale-select"
          value={selectedLocale}
          onChange={handleLocaleChange}
        >
          <option value="en-US">English (US)</option>
          <option value="en-GB">English (UK)</option>
          <option value="fr-FR">French (France)</option>
          <option value="de-DE">German (Germany)</option>
          <option value="es-ES">Spanish (Spain)</option>
        </select>
      </div>
    </div>
  );
};

// Example usage component
const CurrencyFormatterDemo: React.FC = () => {
  const [amount, setAmount] = useState<number>(1234.56);
  const [currency, setCurrency] = useState<string>("USD");
  const [locale, setLocale] = useState<string>("en-US");

  const exampleTransactions = [
    { id: "1", amount: 100, currency: "USD", description: "Coffee" },
    { id: "2", amount: 5000, currency: "XAF", description: "Lunch" },
    { id: "3", amount: 50.75, currency: "GHS", description: "Transport" },
    { id: "4", amount: 2500.25, currency: "NGN", description: "Shopping" },
  ];

  return (
    <div className="currency-formatter-demo">
      <h2>Currency Formatter Demo</h2>

      <CurrencySettings
        onCurrencyChange={setCurrency}
        onLocaleChange={setLocale}
      />

      <div className="demo-section">
        <h3>Single Amount Display</h3>
        <div className="amount-input">
          <label>Amount:</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
            step="0.01"
          />
        </div>
        <CurrencyDisplay amount={amount} currency={currency} locale={locale} />
      </div>

      <div className="demo-section">
        <h3>Currency Converter</h3>
        <CurrencyConverter
          baseAmount={100}
          baseCurrency="USD"
          targetCurrency="XAF"
          exchangeRate={600} // Example rate: 1 USD = 600 XAF
        />
      </div>

      <div className="demo-section">
        <h3>Batch Transactions</h3>
        <BatchCurrencyFormatter transactions={exampleTransactions} />
      </div>

      <div className="demo-section">
        <h3>Custom Formatting Examples</h3>
        <div className="custom-examples">
          <div>
            <strong>No thousands grouping:</strong>{" "}
            {CurrencyFormatter.format(1234567.89, "USD", {
              useGrouping: false,
            })}
          </div>
          <div>
            <strong>German locale:</strong>{" "}
            {CurrencyFormatter.format(1234.56, "USD", { locale: "de-DE" })}
          </div>
          <div>
            <strong>4 decimal places:</strong>{" "}
            {CurrencyFormatter.format(100, "USD", { minimumFractionDigits: 4 })}
          </div>
          <div>
            <strong>Floor rounding:</strong>{" "}
            {CurrencyFormatter.format(1.999, "USD", { roundingMode: "floor" })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CurrencyFormatterDemo;
