# Currency Formatter Utility

A TypeScript-based currency formatting utility that provides standardized, ISO 4217-compliant currency formatting for XAF, GHS, NGN, and USD currencies. The utility wraps the native `Intl.NumberFormat` API with caching, validation, and error handling capabilities.

## Project Structure

```
src/utils/currency/
├── index.ts                    # Main export file
├── types.ts                    # TypeScript interfaces and types
├── constants.ts                # Default configuration and constants
├── CurrencyFormatter.ts        # Main formatter class
├── CurrencyConfig.ts          # Configuration management
├── ValidationEngine.ts        # Input validation
├── FormatterCache.ts          # Performance caching layer
├── __tests__/                 # Test files
│   ├── jest.config.js         # Jest configuration for currency tests
│   ├── setup.ts               # Test setup and utilities
│   └── project-structure.test.ts # Project structure validation tests
└── README.md                  # This file
```

## Supported Currencies

- **XAF** (Central African CFA Franc): 0 decimal places
- **GHS** (Ghanaian Cedi): 2 decimal places
- **NGN** (Nigerian Naira): 2 decimal places
- **USD** (US Dollar): 2 decimal places

## Key Features

- **ISO 4217 Compliance**: Full adherence to international currency formatting standards
- **Performance Optimized**: Caching layer for `Intl.NumberFormat` instances
- **Comprehensive Validation**: Input validation for amounts, currency codes, and locales
- **Error Handling**: Graceful error handling with fallback mechanisms
- **TypeScript Support**: Full type definitions for better developer experience
- **Property-Based Testing**: Comprehensive test coverage using fast-check

## Requirements Addressed

This implementation addresses the following requirements from the specification:

### Task 1 Requirements:

- **Requirement 7.1**: Load configuration from a centralized configuration source
- **Requirement 7.4**: Validate configuration parameters on initialization

## Testing

The project uses a dual testing approach:

### Unit Tests

- Specific examples and edge cases
- Integration scenarios
- Error handling validation

### Property-Based Tests

- Universal correctness properties
- Comprehensive input coverage using fast-check
- Performance validation

### Running Tests

```bash
# Run all currency formatter tests
npm test -- src/utils/currency

# Run specific test file
npm test -- src/utils/currency/__tests__/project-structure.test.ts

# Run tests with coverage
npm run test:coverage -- src/utils/currency
```

## Configuration

The utility uses a centralized configuration system defined in `constants.ts`:

```typescript
import { DEFAULT_CONFIG, SUPPORTED_CURRENCIES } from "./constants";

// Access currency rules
const usdRule = DEFAULT_CONFIG.currencies.USD;

// Check supported currencies
console.log(SUPPORTED_CURRENCIES); // ['XAF', 'GHS', 'NGN', 'USD']
```

## Development Status

This is Task 1 of the implementation plan. The project structure and core interfaces have been established. Subsequent tasks will implement the actual formatting logic, validation, caching, and comprehensive testing.

### Completed:

- ✅ Directory structure in `src/utils/currency/`
- ✅ TypeScript interfaces and types for currency configuration
- ✅ Jest testing framework configuration
- ✅ Default currency configuration for XAF, GHS, NGN, USD
- ✅ Core class structure (stubs)
- ✅ Project structure validation tests

### Next Steps:

- Implement core currency configuration system (Task 2)
- Implement input validation engine (Task 3)
- Implement formatter cache system (Task 5)
- Implement main CurrencyFormatter class (Task 6)

## Architecture

The utility follows a layered architecture:

1. **Application Layer**: Public API (`CurrencyFormatter`)
2. **Validation Layer**: Input validation (`ValidationEngine`)
3. **Configuration Layer**: Currency rules management (`CurrencyConfig`)
4. **Performance Layer**: Caching (`FormatterCache`)
5. **Core Layer**: `Intl.NumberFormat` wrapper

## Type Safety

All components are fully typed with TypeScript, providing:

- Compile-time type checking
- IntelliSense support
- Runtime type validation
- Clear interface contracts

## Performance Considerations

- Caching of `Intl.NumberFormat` instances
- Lazy initialization of formatters
- Performance monitoring and thresholds
- Memory-efficient cache management with LRU eviction
