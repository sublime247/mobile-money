import subscriptionModel from '../../../models/subscription';
import * as db from '../../../config/database';

jest.mock('../../../config/database');

const mockedRead = db.queryRead as jest.MockedFunction<typeof db.queryRead>;
const mockedWrite = db.queryWrite as jest.MockedFunction<typeof db.queryWrite>;

describe('SubscriptionModel', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('getDueSubscriptions forwards query and returns rows', async () => {
    mockedRead.mockResolvedValueOnce({ rows: [{ id: 's1' }], rowCount: 1 } as any);
    const rows = await subscriptionModel.getDueSubscriptions(10);
    expect(mockedRead).toHaveBeenCalled();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('s1');
  });

  test('create uses queryWrite and returns created row', async () => {
    const fakeRow = { id: 's2', amount: '10' };
    mockedWrite.mockResolvedValueOnce({ rows: [fakeRow] } as any);
    const created = await subscriptionModel.create({
      merchant_id: 'm1',
      amount: '10',
      interval: 'daily',
    } as any);
    expect(mockedWrite).toHaveBeenCalled();
    expect(created.id).toBe('s2');
  });

  test('listByMerchant returns rows', async () => {
    mockedRead.mockResolvedValueOnce({ rows: [{ id: 's3' }] } as any);
    const rows = await subscriptionModel.listByMerchant('m1');
    expect(mockedRead).toHaveBeenCalledWith(expect.any(String), ['m1']);
    expect(rows[0].id).toBe('s3');
  });

  test('update constructs SET clause and returns updated row', async () => {
    mockedWrite.mockResolvedValueOnce({ rows: [{ id: 's4', status: 'paused' }] } as any);
    const updated = await subscriptionModel.update('s4', { status: 'paused' });
    expect(mockedWrite).toHaveBeenCalled();
    expect(updated.status).toBe('paused');
  });

  test('delete calls queryWrite', async () => {
    mockedWrite.mockResolvedValueOnce({} as any);
    await subscriptionModel.delete('s5');
    expect(mockedWrite).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM subscriptions'), ['s5']);
  });
});
