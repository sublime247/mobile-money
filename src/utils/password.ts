import bcrypt from 'bcrypt';

const rounds = Number(process.env.BCRYPT_ROUNDS) || 10;

/**
 * Hash a plain text password
 * @param password Plain password to hash
 * @returns Promise<string> hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  try {
    const hash = await bcrypt.hash(password, rounds);
    return hash;
  } catch (error) {
    console.error('Error hashing password:', error);
    throw new Error('Could not hash password');
  }
}

/**
 * Compare a plain text password with a hashed password
 * @param password Plain password
 * @param hash Hashed password
 * @returns Promise<boolean> true if match, false otherwise
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch (error) {
    console.error('Error comparing password:', error);
    throw new Error('Could not compare password');
  }
}