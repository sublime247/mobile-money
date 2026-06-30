# CurrencyFormatter - Frontend Usage Guide

## Overview

The CurrencyFormatter utility provides ISO 4217-compliant currency formatting for XAF, GHS, NGN, and USD currencies. It's designed to work seamlessly in frontend applications (React, Vue, Angular, or vanilla JavaScript).

## Installation

### For TypeScript/JavaScript Projects

```bash
# If using npm
npm install @your-org/currency-formatter

# If using yarn
yarn add @your-org/currency-formatter
```

### Direct Import (if bundled)

```javascript
// ES Modules
import {
  CurrencyFormatter,
  CurrencyConfig,
} from "@your-org/currency-formatter";

// CommonJS
const {
  CurrencyFormatter,
  CurrencyConfig,
} = require("@your-org/currency-formatter");
```

## Basic Usage

### Formatting Single Amounts

```typescript
import { CurrencyFormatter } from "@your-org/currency-formatter";

// Format USD amount
const usdFormatted = CurrencyFormatter.format(1234.56, "USD");
console.log(usdFormatted); // "$1,234.56"

// Format XAF amount (0 decimal places)
const xafFormatted = CurrencyFormatter.format(5000, "XAF");
console.log(xafFormatted); // "5 000 FCFA"

// Format GHS amount
const ghsFormatted = CurrencyFormatter.format(99.99, "GHS");
console.log(ghsFormatted); // "GH₵99.99"

// Format NGN amount
const ngnFormatted = CurrencyFormatter.format(1000.5, "NGN");
console.log(ngnFormatted); // "₦1,000.50"
```

### Batch Formatting for Performance

```typescript
const transactions = [
  { amount: 100, currency: "USD" },
  { amount: 5000, currency: "XAF" },
  { amount: 50.75, currency: "GHS" },
  { amount: 2500.25, currency: "NGN" },
];

const formatted = CurrencyFormatter.formatBatch(transactions);
// Returns: ["$100.00", "5 000 FCFA", "GH₵50.75", "₦2,500.25"]
```

## React Integration

### Basic Component

```tsx
import React, { useState, useEffect } from "react";
import { CurrencyFormatter } from "@your-org/currency-formatter";

interface CurrencyDisplayProps {
  amount: number;
  currency: string;
  locale?: string;
}

const CurrencyDisplay: React.FC<CurrencyDisplayProps> = ({
  amount,
  currency,
  locale,
}) => {
  const [formatted, setFormatted] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const formattedAmount = CurrencyFormatter.format(amount, currency, {
        locale,
      });
      setFormatted(formattedAmount);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Formatting error");
    }
  }, [amount, currency, locale]);

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return <div className="currency">{formatted}</div>;
};

// Usage
<CurrencyDisplay amount={1234.56} currency="USD" locale="en-US" />;
```

### Advanced React Hook

```tsx
import { useState, useEffect } from "react";
import { CurrencyFormatter } from "@your-org/currency-formatter";

export function useCurrencyFormat(
  amount: number,
  currency: string,
  options = {},
) {
  const [formatted, setFormatted] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    try {
      const result = CurrencyFormatter.format(amount, currency, options);
      setFormatted(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Formatting error");
      setFormatted("");
    } finally {
      setLoading(false);
    }
  }, [amount, currency, options]);

  return { formatted, loading, error };
}

// Usage in component
function MyComponent() {
  const { formatted, loading, error } = useCurrencyFormat(1234.56, "USD");

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  return <div>{formatted}</div>;
}
```

## Vue Integration

### Vue 3 Composition API

```vue
<template>
  <div>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-else class="currency">{{ formattedAmount }}</div>
  </div>
</template>

<script setup>
import { ref, watch } from "vue";
import { CurrencyFormatter } from "@your-org/currency-formatter";

const props = defineProps({
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  locale: { type: String, default: "en-US" },
});

const formattedAmount = ref("");
const error = ref(null);

watch(
  () => [props.amount, props.currency, props.locale],
  () => {
    try {
      formattedAmount.value = CurrencyFormatter.format(
        props.amount,
        props.currency,
        {
          locale: props.locale,
        },
      );
      error.value = null;
    } catch (err) {
      error.value = err.message;
      formattedAmount.value = "";
    }
  },
  { immediate: true },
);
</script>
```

## Angular Integration

### Angular Service

```typescript
import { Injectable } from "@angular/core";
import { CurrencyFormatter } from "@your-org/currency-formatter";

@Injectable({
  providedIn: "root",
})
export class CurrencyService {
  format(amount: number, currency: string, options?: any): string {
    try {
      return CurrencyFormatter.format(amount, currency, options);
    } catch (error) {
      console.error("Currency formatting error:", error);
      return `${currency} ${amount}`;
    }
  }

  formatBatch(
    amounts: Array<{ amount: number; currency: string }>,
    options?: any,
  ): string[] {
    return CurrencyFormatter.formatBatch(amounts, options);
  }
}
```

### Angular Component

```typescript
import { Component, Input, OnChanges, SimpleChanges } from "@angular/core";
import { CurrencyService } from "./currency.service";

@Component({
  selector: "app-currency-display",
  template: `
    <div *ngIf="error" class="error">{{ error }}</div>
    <div *ngIf="!error" class="currency">{{ formattedAmount }}</div>
  `,
})
export class CurrencyDisplayComponent implements OnChanges {
  @Input() amount!: number;
  @Input() currency!: string;
  @Input() locale: string = "en-US";

  formattedAmount: string = "";
  error: string | null = null;

  constructor(private currencyService: CurrencyService) {}

  ngOnChanges(changes: SimpleChanges): void {
    try {
      this.formattedAmount = this.currencyService.format(
        this.amount,
        this.currency,
        { locale: this.locale },
      );
      this.error = null;
    } catch (error: any) {
      this.error = error.message;
      this.formattedAmount = "";
    }
  }
}
```

## Custom Formatting Options

### Locale Overrides

```typescript
// German locale (uses comma as decimal separator)
CurrencyFormatter.format(1234.56, "USD", { locale: "de-DE" });
// Returns: "1.234,56 $"

// French locale
CurrencyFormatter.format(1234.56, "USD", { locale: "fr-FR" });
// Returns: "1 234,56 $"
```

### Thousands Grouping

```typescript
// Disable thousands grouping
CurrencyFormatter.format(1000000, "USD", { useGrouping: false });
// Returns: "$1000000.00"

// Enable thousands grouping (default)
CurrencyFormatter.format(1000000, "USD", { useGrouping: true });
// Returns: "$1,000,000.00"
```

### Decimal Precision

```typescript
// Custom decimal places
CurrencyFormatter.format(100, "USD", { minimumFractionDigits: 4 });
// Returns: "$100.0000"

CurrencyFormatter.format(100.123456, "USD", { maximumFractionDigits: 3 });
// Returns: "$100.123"
```

### Rounding Modes

```typescript
// Floor rounding (round down)
CurrencyFormatter.format(1.999, "USD", { roundingMode: "floor" });
// Returns: "$1.99"

// Ceil rounding (round up)
CurrencyFormatter.format(1.001, "USD", { roundingMode: "ceil" });
// Returns: "$1.01"

// Standard rounding (default)
CurrencyFormatter.format(1.555, "USD", { roundingMode: "round" });
// Returns: "$1.56"
```

## Error Handling

### Try/Catch Approach

```typescript
try {
  const formatted = CurrencyFormatter.format(amount, currency, options);
  // Use formatted value
} catch (error) {
  console.error("Formatting failed:", error.message);
  // Fallback formatting
  const fallback = `${currency} ${amount}`;
}
```

### Graceful Error Handling

```typescript
const result = CurrencyFormatter.formatWithResult(amount, currency, options);

if (result.success) {
  console.log("Formatted:", result.formatted);
} else {
  console.error("Error:", result.error);
  // Use fallback value if provided
  const fallback = result.fallbackValue || `${currency} ${amount}`;
}
```

## Configuration Management

### Runtime Configuration

```typescript
import { CurrencyConfig } from "@your-org/currency-formatter";

// Get supported currencies
const supported = CurrencyConfig.getSupportedCurrencies();
// Returns: ['XAF', 'GHS', 'NGN', 'USD']

// Get currency information
const symbol = CurrencyConfig.getCurrencySymbol("USD"); // "$"
const name = CurrencyConfig.getCurrencyName("USD"); // "US Dollar"
const locale = CurrencyConfig.getDefaultLocale("USD"); // "en-US"

// Update configuration at runtime
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
```

## Performance Tips

1. **Use batch formatting** for multiple amounts
2. **Cache formatter instances** when using the same currency/locale repeatedly
3. **Avoid unnecessary re-formatting** in React/Vue components
4. **Use memoization** for expensive formatting operations

### Performance Comparison

```typescript
// Single formatting (1000 operations)
const startSingle = performance.now();
for (let i = 0; i < 1000; i++) {
  CurrencyFormatter.format(100 + i, "USD");
}
const endSingle = performance.now();

// Batch formatting (1000 operations)
const batchData = Array.from({ length: 1000 }, (_, i) => ({
  amount: 100 + i,
  currency: "USD",
}));

const startBatch = performance.now();
CurrencyFormatter.formatBatch(batchData);
const endBatch = performance.now();

console.log(`Single: ${(endSingle - startSingle).toFixed(2)}ms`);
console.log(`Batch: ${(endBatch - startBatch).toFixed(2)}ms`);
console.log(
  `Batch is ${((endSingle - startSingle) / (endBatch - startBatch)).toFixed(1)}x faster`,
);
```

## Browser Compatibility

The CurrencyFormatter utility:

- Works in all modern browsers (Chrome, Firefox, Safari, Edge)
- Uses native `Intl.NumberFormat` API with fallbacks
- No polyfills required for modern browsers
- For older browsers, consider polyfilling `Intl.NumberFormat`

## Examples

Check out the example files:

- `examples/react-usage.tsx` - React component examples
- `examples/vanilla-usage.ts` - Vanilla JavaScript examples
- `examples/browser-demo.html` - Browser demo with HTML/CSS/JS

## TypeScript Support

Full TypeScript support included with:

- Complete type definitions
- Interface documentation
- Type-safe configuration
- Editor autocompletion

## License

MIT License - See LICENSE file for details.

## Support

For issues, questions, or contributions:

1. Check the documentation
2. Look at example files
3. Open an issue on GitHub
4. Contact the development team
