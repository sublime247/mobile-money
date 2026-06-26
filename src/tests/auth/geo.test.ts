import { Request } from 'express';

function makeRequest(ip: string): Request {
  return {
    ip,
    headers: {}
  } as unknown as Request;
}

describe('evaluateGeoLoginAccess', () => {
  const previousEnv = { ...process.env };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...previousEnv };
    delete process.env.MAXMIND_GEOIP_DB_PATH;
    delete process.env.GEO_WHITELIST_IPS;
    delete process.env.GEO_SANCTIONED_COUNTRIES;
    const { resetGeoReader } = await import('../../auth/geo');
    resetGeoReader();
  });

  afterAll(() => {
    process.env = previousEnv;
  });

  it('allows requests from whitelisted IPs', async () => {
    process.env.GEO_WHITELIST_IPS = '203.0.113.7';
    const { evaluateGeoLoginAccess } = await import('../../auth/geo');

    const result = await evaluateGeoLoginAccess(makeRequest('203.0.113.7'));

    expect(result.allowed).toBe(true);
  });

  it('blocks requests from sanctioned regions', async () => {
    process.env.MAXMIND_GEOIP_DB_PATH = '/tmp/fake.mmdb';

    jest.doMock(
      'maxmind',
      () => ({
        open: jest.fn().mockResolvedValue({
          get: () => ({ country: { iso_code: 'IR' } })
        })
      }),
      { virtual: true }
    );

    const { evaluateGeoLoginAccess } = await import('../../auth/geo');
    const result = await evaluateGeoLoginAccess(makeRequest('198.51.100.42'));

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('IR');
  });
});
