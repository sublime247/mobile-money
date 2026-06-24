# Contributing to Mobile Money to Stellar Bridge

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## 🌟 Ways to Contribute

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/backend.git`
3. Add the original repository as an upstream remote:
   `git remote add upstream https://github.com/sublime247/mobile-money.git`
4. Sync your local main branch with upstream:
   `git checkout main`
   `git pull upstream main`
5. Create a feature branch: `git checkout -b feature/your-feature`
6. Make your changes.
7. Run tests and linting.
8. Commit: `git commit -m "Add your feature"`
9. Push: `git push origin feature/your-feature`
10. Open a Pull Request:
    *   Go to your forked repository on GitHub.
    *   Click the "Compare & pull request" button.
    *   Ensure the base repository is `sublime247/mobile-money` (main branch) and the head repository is your fork (your feature branch).
    *   Provide a clear and descriptive title and description for your Pull Request. Include:
        *   A summary of the changes.
        *   Why these changes were made (e.g., fixing a bug, adding a feature).
        *   References to any related issues (e.g., `Fixes #123`).
        *   Instructions on how to test your changes.
- **Report bugs** via GitHub Issues
- **Suggest features** or enhancements
- **Improve documentation**
- **Submit pull requests** with bug fixes or new features
- **Review pull requests** from other contributors
- **Help answer questions** in Discussions

## 🚀 Getting Started

### 1. Fork and Clone

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/mobile-money.git
cd mobile-money

# Add upstream remote
git remote add upstream https://github.com/sublime247/mobile-money.git
```

### 2. Set Up Development Environment

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Set up database
npm run migrate:up

# Run tests to verify setup
npm test
```

### 3. Create a Branch

```bash
# Update your fork
git checkout main
git pull upstream main

# Create a feature branch
git checkout -b feature/your-feature-name
```

## 📝 Development Guidelines

### Code Style

We use ESLint and Prettier for code formatting:

```bash
# Check linting
npm run lint

# Format code
npm run format

# Type check
npm run type-check
```

### Commit Messages

Follow conventional commits format:

```
type(scope): subject

body (optional)

footer (optional)
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(transactions): add support for Orange Money
fix(auth): resolve JWT expiration issue
docs(readme): update installation instructions
test(kyc): add unit tests for document validation
```

### Testing Requirements

All contributions must include tests:

```bash
# Run all tests
npm test

# Run specific test file
npm test -- path/to/test.ts

# Run with coverage
npm run test:coverage

# Run Pact contract tests
npm run test:pact
```

**Test Coverage Requirements:**
- Minimum 70% coverage for all metrics
- New features must have >80% coverage
- Bug fixes must include regression tests

**Contract Testing:**
- Provider API changes require updating Pact contracts
- Run `npm run test:pact` to verify contracts
- See `tests/pact/README.md` for details

### Code Review Checklist

Before submitting a PR, ensure:

- [ ] Code follows project style guidelines
- [ ] All tests pass
- [ ] New tests added for new features
- [ ] Documentation updated
- [ ] No console.log statements (use proper logging)
- [ ] No commented-out code
- [ ] TypeScript types are properly defined
- [ ] Error handling is implemented
- [ ] Security considerations addressed

## 🐛 Reporting Bugs

### Before Submitting

1. Check existing issues to avoid duplicates
2. Verify the bug exists in the latest version
3. Collect relevant information

### Bug Report Template

```markdown
**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What you expected to happen.

**Actual behavior**
What actually happened.

**Environment:**
- OS: [e.g., Ubuntu 22.04]
- Node.js version: [e.g., 20.10.0]
- PostgreSQL version: [e.g., 16.1]
- Redis version: [e.g., 7.2]

**Additional context**
- Error messages
- Logs
- Screenshots
```

## 💡 Suggesting Features

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
A clear description of the problem.

**Describe the solution you'd like**
A clear description of what you want to happen.

**Describe alternatives you've considered**
Alternative solutions or features you've considered.

**Additional context**
Any other context, mockups, or examples.

**Implementation ideas**
If you have ideas on how to implement this.
```

## 🔧 Pull Request Process

### 1. Prepare Your Changes

```bash
# Make your changes
# Add tests
# Update documentation

# Run quality checks
npm run lint
npm run type-check
npm test
```

### 2. Commit Your Changes

```bash
git add .
git commit -m "feat(scope): description"
```

### 3. Push to Your Fork

```bash
git push origin feature/your-feature-name
```

### 4. Create Pull Request

1. Go to the original repository on GitHub
2. Click "New Pull Request"
3. Select your fork and branch
4. Fill out the PR template
5. Submit the PR

### Pull Request Template

```markdown
## Description
Brief description of changes.

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to change)
- [ ] Documentation update

## Related Issue
Fixes #(issue number)

## How Has This Been Tested?
Describe the tests you ran.

## Checklist
- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review
- [ ] I have commented my code where necessary
- [ ] I have updated the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix/feature works
- [ ] New and existing tests pass locally
- [ ] Any dependent changes have been merged

## Screenshots (if applicable)
Add screenshots to help explain your changes.
```

### 5. Code Review

- Respond to feedback promptly
- Make requested changes
- Push updates to the same branch
- Request re-review when ready

### 6. Merge

Once approved:
- Maintainers will merge your PR
- Your branch will be deleted
- Changes will be included in the next release

## 🏷️ Issue Labels

- `good first issue`: Good for newcomers
- `help wanted`: Extra attention needed
- `bug`: Something isn't working
- `enhancement`: New feature or request
- `documentation`: Documentation improvements
- `question`: Further information requested
- `wontfix`: This will not be worked on
- `duplicate`: This issue already exists
- `invalid`: This doesn't seem right

## 🎯 Good First Issues

New to the project? Look for issues labeled `good first issue`:

**Examples:**
- Add input validation
- Improve error messages
- Add unit tests
- Update documentation
- Fix typos
- Add logging

## 🔔 CI Slack Notifications

When a CI run fails on the `main` branch, an automatic Slack notification is sent with the workflow name, triggering actor, commit SHA, and a direct link to the failed run.

### Required secret

| Secret name | Where to get it |
|---|---|
| `SLACK_WEBHOOK_URL` | Create an [Incoming Webhook](https://api.slack.com/messaging/webhooks) in your Slack workspace, then add the generated URL as a repository secret under **Settings → Secrets and variables → Actions**. |

Notifications fire **only** on `main` branch failures. Passing builds and pull-request runs are never notified.

---

## 🔒 Security Issues

**DO NOT** open public issues for security vulnerabilities.

Instead, email security@yourdomain.com with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We'll respond within 48 hours.

## 📚 Documentation

### Types of Documentation

1. **Code Comments**: Explain complex logic
2. **API Documentation**: Document all endpoints
3. **README**: Keep up-to-date
4. **Architecture Docs**: Explain system design
5. **Migration Guides**: For breaking changes

### Documentation Style

- Use clear, concise language
- Include code examples
- Add diagrams where helpful
- Keep it up-to-date

## 🧪 Testing Guidelines

### Test Structure

```typescript
describe('Feature Name', () => {
  describe('Method/Function Name', () => {
    it('should do something specific', () => {
      // Arrange
      const input = 'test';
      
      // Act
      const result = functionUnderTest(input);
      
      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

### Test Types

1. **Unit Tests**: Test individual functions/methods
2. **Integration Tests**: Test component interactions
3. **E2E Tests**: Test complete user flows
4. **Load Tests**: Test performance under load

### Mocking

- Mock external services (APIs, databases)
- Use Jest mocks for dependencies
- Keep mocks simple and focused

## 🌐 Internationalization

When adding user-facing text:

```typescript
// Use i18n
import { t } from '../utils/i18n';

const message = t('errors.transaction.insufficient_funds');
```

Add translations to `src/locales/`.

## ⚡ Performance Considerations

- Avoid N+1 queries
- Use database indexes
- Implement caching where appropriate
- Profile before optimizing
- Document performance-critical code

## 🔐 Security Considerations

**🚨 CRITICAL: Never commit secrets or API keys**

- Use environment variables for ALL sensitive data (API keys, passwords, tokens, etc.)
- Check [Secrets Management Guide](./docs/SECRETS_MANAGEMENT.md) for detailed guidelines
- All secrets must be managed via GitHub Actions Secrets or environment variables
- GitGuardian scans all PRs for accidentally committed secrets
- If you accidentally commit a secret:
  1. Immediately revoke the compromised credential
  2. Remove it from your PR using `git filter-branch` or force push with amended commits
  3. Notify the security team
  4. Never reuse the same credential

**Other Security Requirements:**
- Validate all user input (use libraries like `zod` for schema validation)
- Use parameterized queries (never string concatenation for SQL)
- Implement rate limiting on all public endpoints
- Follow OWASP guidelines (see [OWASP Top 10](https://owasp.org/www-project-top-ten/))
- Use security headers (Helmet middleware)
- Enable CORS correctly (restrict to known origins)
- Implement proper authentication and authorization
- Keep dependencies up to date (check with `npm audit`)

## 📦 Dependencies

### Adding Dependencies

```bash
# Production dependency
npm install package-name

# Development dependency
npm install --save-dev package-name
```

**Guidelines:**
- Justify new dependencies
- Check for security vulnerabilities
- Prefer well-maintained packages
- Consider bundle size impact

### Updating Dependencies

```bash
# Check for updates
npm outdated

# Update specific package
npm update package-name

# Update all packages
npm update
```

## 🎨 UI/UX Guidelines

When adding user-facing features:

- Follow existing patterns
- Ensure accessibility (WCAG 2.1 AA)
- Test on multiple devices
- Provide clear error messages
- Include loading states
- Handle edge cases

## 🚀 Release Process

Maintainers handle releases:

1. Update version in `package.json`
2. Update CHANGELOG.md
3. Create release tag
4. Publish to npm (if applicable)
5. Deploy to production

## 💬 Communication

- **GitHub Issues**: Bug reports, feature requests
- **GitHub Discussions**: Questions, ideas, general discussion
- **Pull Requests**: Code review, implementation discussion
- **Email**: Security issues, private matters

## 🙏 Recognition

Contributors are recognized in:
- README.md contributors section
- Release notes
- GitHub contributors page

## 📜 Code of Conduct

### Our Pledge

We pledge to make participation in our project a harassment-free experience for everyone.

### Our Standards

**Positive behavior:**
- Using welcoming and inclusive language
- Being respectful of differing viewpoints
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards others

**Unacceptable behavior:**
- Trolling, insulting/derogatory comments
- Public or private harassment
- Publishing others' private information
- Other conduct which could reasonably be considered inappropriate

### Enforcement

Violations may result in:
1. Warning
2. Temporary ban
3. Permanent ban

Report violations to conduct@yourdomain.com.

## 📞 Questions?

- Check existing documentation
- Search closed issues
- Ask in GitHub Discussions
- Email: support@yourdomain.com

## 🎓 Learning Resources

- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Express.js Guide](https://expressjs.com/en/guide/routing.html)
- [Stellar Documentation](https://developers.stellar.org/)
- [PostgreSQL Tutorial](https://www.postgresql.org/docs/)
- [Jest Testing](https://jestjs.io/docs/getting-started)

---

Thank you for contributing to financial inclusion in Africa! 🌍
