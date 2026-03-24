import { hashPassword, comparePassword } from './password';

describe('Password utils', () => {
  it('should hash a password and compare correctly', async () => {
    const password = 'Test123!';
    const hash = await hashPassword(password);

    expect(typeof hash).toBe('string');
    expect(hash).not.toBe(password);

    const valid = await comparePassword(password, hash);
    expect(valid).toBe(true);

    const invalid = await comparePassword('wrongpass', hash);
    expect(invalid).toBe(false);
  });
});