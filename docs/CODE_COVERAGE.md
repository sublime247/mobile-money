# Code Coverage

## Overview

The project uses Jest for testing and coverage tracking. Local HTML and LCOV coverage reports are generated during test runs.

## Coverage Requirements

### Minimum Thresholds

- **Branches**: 70%
- **Functions**: 70%
- **Lines**: 70%
- **Statements**: 70%

These thresholds are enforced by Jest and will fail builds that don't meet requirements.

## Viewing Coverage

Run coverage locally:
```bash
npm run test:coverage
```

Coverage reports are generated in the `coverage/` directory:
- HTML report: `coverage/index.html` (open in browser for line-by-line visualization)
- Summary: `coverage/coverage-summary.json`

### Local Coverage Report

```bash
# Run tests with coverage
npm run test:coverage

# Open HTML report
open coverage/lcov-report/index.html
```

## Running Tests

### All Tests

```bash
npm test
```

### Watch Mode

```bash
npm run test:watch
```

### With Coverage

```bash
npm run test:coverage
```

### Specific Test File

```bash
npm test -- referenceGenerator.test.ts
```

## Writing Tests

### Test File Location

- Place tests in `tests/` directory
- Mirror source structure: `src/utils/file.ts` → `tests/utils/file.test.ts`
- Or use `__tests__` directories within source folders

### Test File Naming

- `*.test.ts` - Unit tests
- `*.spec.ts` - Integration tests

### Example Test

```typescript
import { myFunction } from "../../src/utils/myFunction";

describe("myFunction", () => {
  it("should do something", () => {
    const result = myFunction("input");
    expect(result).toBe("expected");
  });

  it("should handle errors", () => {
    expect(() => myFunction(null)).toThrow("Error message");
  });
});
```

## Coverage Configuration

### Jest Configuration

Coverage settings in `jest.config.js`:

```javascript
collectCoverageFrom: [
  'src/**/*.ts',
  '!src/**/*.d.ts',
  '!src/index.ts',
  '!src/**/__tests__/**'
],
coverageThreshold: {
  global: {
    branches: 70,
    functions: 70,
    lines: 70,
    statements: 70
  }
}
```

### Codecov Configuration

## CI/CD Integration

Coverage reports are generated during Jest test runs in the CI/CD pipeline:
- See `.github/workflows/ci.yml` and `.github/workflows/coverage.yml`

## Coverage Best Practices

### 1. Test Critical Paths

Focus on:
- Business logic
- Data transformations
- Error handling
- Edge cases

### 2. Don't Test Everything

Skip:
- Type definitions
- Simple getters/setters
- Configuration files
- Third-party integrations (mock instead)

### 3. Aim for Meaningful Coverage

- 70% is minimum, not target
- 100% coverage doesn't mean bug-free
- Focus on quality over quantity

### 4. Review Coverage Reports

- Check which lines are uncovered
- Identify untested edge cases
- Look for dead code

## Troubleshooting

### Tests Failing in CI

- Ensure all dependencies in package.json
- Check environment variables are set
- Verify database/Redis services are healthy

### Coverage Below Threshold

- Run `npm run test:coverage` locally
- Check coverage report: `coverage/lcov-report/index.html`
- Add tests for uncovered code
- Consider adjusting thresholds if unrealistic

## Excluded from Coverage

- Test files (`*.test.ts`, `*.spec.ts`)
- Example files (`examples/**/*`)
- Type definitions (`*.d.ts`)
- Entry point (`src/index.ts`)
- Build output (`dist/**/*`)
