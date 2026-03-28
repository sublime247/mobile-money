import { test, expect, request } from '@playwright/test';
import app from '../../src/index';
import type { Server } from 'http';

let server: Server;
const port = Number(process.env.E2E_PORT || 3000);
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;

test.beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  server = app.listen(port);
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

test('login endpoint issues JWT and refresh token, /me returns permissions', async () => {
  const api = await request.newContext({ baseURL });

  const loginResponse = await api.post('/api/auth/login', {
    data: { phone_number: '+237777777777' },
  });

  expect(loginResponse.ok()).toBeTruthy();
  const loginBody = await loginResponse.json();
  expect(loginBody.token).toBeTruthy();
  expect(loginBody.refreshToken).toBeTruthy();
  expect(loginBody.user).toBeTruthy();
  expect(loginBody.user.role).toBeTruthy();

  const meResponse = await api.get('/api/auth/me', {
    headers: {
      Authorization: `Bearer ${loginBody.token}`,
    },
  });

  expect(meResponse.ok()).toBeTruthy();
  const meBody = await meResponse.json();
  expect(meBody.user).toBeTruthy();
  expect(meBody.user.userId).toEqual(loginBody.user.userId);
  expect(meBody.user.permissions).toBeInstanceOf(Array);
});
