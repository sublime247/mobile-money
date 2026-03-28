process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test_user:test_password@localhost:5432/test_db";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.STELLAR_ISSUER_SECRET ??=
  "SBV7YI7E6M2R7X7G6Q2P4JZJQW4G4Q2XK4M5M4KQ4Q2G4X4Q2M4JQ";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.ADMIN_API_KEY ??= "test-admin-key";
process.env.DB_ENCRYPTION_KEY ??= "development-encryption-key-32-chars-long";
