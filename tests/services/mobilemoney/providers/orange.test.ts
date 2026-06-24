import axios from 'axios';
import { OrangeProvider } from '../../../../src/services/mobilemoney/providers/orange';

jest.mock('axios');

describe('OrangeProvider', () => {
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  // Type guard that narrows the union returned by the provider
  function assertSuccess<T = any>(res: unknown): asserts res is { success: true; data?: T; reference?: string } {
    if (!res || (res as any).success !== true) {
      throw new Error('Expected successful response');
    }
  }

  let providers: OrangeProvider[] = [];

  beforeEach(() => {
    jest.resetAllMocks();
    providers = [];
  });

  afterEach(() => {
    for (const p of providers) {
      try {
        p.destroy();
      } catch {}
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('requestPayment authenticates and returns success', async () => {
    const client: any = {
      post: jest.fn(),
      get: jest.fn(),
    };

    // axios.create should return our client
    mockedAxios.create.mockReturnValue(client as any);

    // First post call is /oauth/token
    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === '/oauth/token')
        return Promise.resolve({ data: { access_token: 'tok', expires_in: 3600 } });
      return Promise.reject(new Error('unexpected'));
    });

    // Second call is /v1/payments/collect
    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === '/v1/payments/collect')
        return Promise.resolve({ data: { status: 'PENDING', id: body.transaction.id } });
      return Promise.reject(new Error('unexpected'));
    });

    const p = new OrangeProvider();
    providers.push(p);
    const res = await p.requestPayment('+237600000000', 1000);

    expect(res.success).toBe(true);
    assertSuccess(res);
    expect(res.data).toBeDefined();
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  test('sendPayout succeeds', async () => {
    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === '/oauth/token')
        return Promise.resolve({ data: { access_token: 'tok2', expires_in: 3600 } });
      return Promise.reject(new Error('unexpected'));
    });

    client.post.mockImplementationOnce((url: string, body: any, opts: any) => {
      if (url === '/v1/payments/disburse')
        return Promise.resolve({ data: { status: 'SUCCESS', id: body.transaction.id } });
      return Promise.reject(new Error('unexpected'));
    });

    const p = new OrangeProvider();
    providers.push(p);
    const res = await p.sendPayout('+237600000001', 500);

    expect(res.success).toBe(true);
    assertSuccess(res);
    expect(res.reference).toBeDefined();
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  test('checkStatus returns data', async () => {
    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockResolvedValue({ data: { access_token: 'tok3', expires_in: 3600 } });
    client.get.mockResolvedValue({ data: { status: 'COMPLETED' } });

    const p = new OrangeProvider();
    providers.push(p);
    const res = await p.checkStatus('REF-123');

    expect(res.success).toBe(true);
    assertSuccess(res);
    expect(res.data).toEqual({ status: 'COMPLETED' });
  });

  test('retries on 5xx then succeeds', async () => {
    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    // Auth
    client.post.mockImplementationOnce((url: string) => {
      if (url === '/oauth/token') return Promise.resolve({ data: { access_token: 'tok4', expires_in: 3600 } });
      return Promise.reject(new Error('unexpected'));
    });

    // First attempt to collect fails with 500
    client.post.mockImplementationOnce((url: string) => {
      const err: any = new Error('server');
      err.response = { status: 502, data: { message: 'bad' } };
      return Promise.reject(err);
    });

    // Second attempt succeeds
    client.post.mockImplementationOnce((url: string, body: any) => {
      if (url === '/v1/payments/collect') return Promise.resolve({ data: { status: 'PENDING' } });
      return Promise.reject(new Error('unexpected'));
    });

    const p = new OrangeProvider();
    providers.push(p);
    const res = await p.requestPayment('+237600000002', 200);

    expect(res.success).toBe(true);
    // should have called post 3 times (auth + 2 attempts)
    expect(client.post).toHaveBeenCalledTimes(3);
  });

  test('concurrent auth requests share the same in-flight token request', async () => {
    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    let resolveAuth: any;
    const authPromise = new Promise((resolve) => {
      resolveAuth = resolve;
    });

    client.post.mockImplementation((url: string) => {
      if (url === '/oauth/token') {
        return authPromise;
      }
      if (url === '/v1/payments/collect') {
        return Promise.resolve({ status: 200, data: { status: 'PENDING' } });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const p = new OrangeProvider({
      apiKey: 'key',
      apiSecret: 'secret',
      mode: 'direct',
    });
    providers.push(p);

    const req1 = p.requestPayment('+237600000001', 100);
    const req2 = p.requestPayment('+237600000002', 200);

    resolveAuth({ status: 200, data: { access_token: 'shared-token', expires_in: 3600 } });

    await Promise.all([req1, req2]);

    const authCalls = client.post.mock.calls.filter(([url]: any) => url === '/oauth/token');
    expect(authCalls).toHaveLength(1);

    p.destroy();
  });

  test('proactively pre-fetches token before expiration', async () => {
    jest.useFakeTimers();
    let currentTime = 1000;
    const clock = () => currentTime;

    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockResolvedValue({ status: 200, data: { access_token: 'token-1', expires_in: 3600 } });

    const p = new OrangeProvider({
      apiKey: 'key',
      apiSecret: 'secret',
      mode: 'direct',
      clock,
      refreshSkewMs: 60000,
    });
    providers.push(p);

    const token1 = await (p as any).authenticateDirect();
    expect(token1).toBe('token-1');
    expect(client.post).toHaveBeenCalledTimes(1);

    client.post.mockResolvedValue({ status: 200, data: { access_token: 'token-2', expires_in: 3600 } });

    currentTime += 3539000;
    await jest.advanceTimersByTimeAsync(3539000);
    expect(client.post).toHaveBeenCalledTimes(1);

    currentTime += 2000;
    await jest.advanceTimersByTimeAsync(2000);

    expect(client.post).toHaveBeenCalledTimes(2);

    const token2 = await (p as any).authenticateDirect();
    expect(token2).toBe('token-2');

    p.destroy();
    jest.useRealTimers();
  });

  test('retries pre-fetching on authentication failure', async () => {
    jest.useFakeTimers();
    let currentTime = 1000;
    const clock = () => currentTime;

    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockResolvedValueOnce({ status: 200, data: { access_token: 'token-1', expires_in: 3600 } });

    const p = new OrangeProvider({
      apiKey: 'key',
      apiSecret: 'secret',
      mode: 'direct',
      clock,
      refreshSkewMs: 60000,
    });
    providers.push(p);

    const token1 = await (p as any).authenticateDirect();
    expect(token1).toBe('token-1');
    expect(client.post).toHaveBeenCalledTimes(1);

    // Fail the pre-fetch auth call
    client.post.mockRejectedValueOnce(new Error('Auth failed'));

    // Advance past the threshold to trigger pre-fetch
    currentTime += 3541000;
    await jest.advanceTimersByTimeAsync(3541000);

    // It should have tried to pre-fetch and failed
    expect(client.post).toHaveBeenCalledTimes(2);

    // Set up next call to succeed
    client.post.mockResolvedValueOnce({ status: 200, data: { access_token: 'token-2', expires_in: 3600 } });

    // Advance by 5000 ms to trigger retry
    currentTime += 5000;
    await jest.advanceTimersByTimeAsync(5000);

    // It should have retried and succeeded
    expect(client.post).toHaveBeenCalledTimes(3);

    const token2 = await (p as any).authenticateDirect();
    expect(token2).toBe('token-2');

    p.destroy();
    jest.useRealTimers();
  });

  test('destroy clears the prefetch timer', async () => {
    jest.useFakeTimers();
    let currentTime = 1000;
    const clock = () => currentTime;

    const client: any = { post: jest.fn(), get: jest.fn() };
    mockedAxios.create.mockReturnValue(client as any);

    client.post.mockResolvedValue({ status: 200, data: { access_token: 'token-1', expires_in: 3600 } });

    const p = new OrangeProvider({
      apiKey: 'key',
      apiSecret: 'secret',
      mode: 'direct',
      clock,
      refreshSkewMs: 60000,
    });
    providers.push(p);

    await (p as any).authenticateDirect();
    expect(client.post).toHaveBeenCalledTimes(1);

    p.destroy();

    // Advance time past threshold
    currentTime += 3600000;
    await jest.advanceTimersByTimeAsync(3600000);

    // Should not have pre-fetched because provider was destroyed
    expect(client.post).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
