/**
 * Manual Jest mock for ioredis.
 * Placed in the root __mocks__ directory so Jest can resolve the module
 * even when the package itself is not installed, allowing the global
 * jest.setup.ts to call jest.mock("ioredis", factory) without error.
 */
const EventEmitter = require('events');

class RedisMock extends EventEmitter {
  constructor() {
    super();
    this.status = 'close';
  }
  connect = jest.fn().mockResolvedValue(undefined);
  disconnect = jest.fn().mockResolvedValue(undefined);
  quit = jest.fn().mockResolvedValue(undefined);
  get = jest.fn().mockResolvedValue(null);
  set = jest.fn().mockResolvedValue('OK');
  del = jest.fn().mockResolvedValue(1);
  incr = jest.fn().mockResolvedValue(1);
  expire = jest.fn().mockResolvedValue(1);
  ttl = jest.fn().mockResolvedValue(-1);
  keys = jest.fn().mockResolvedValue([]);
  ping = jest.fn().mockResolvedValue('PONG');
}

module.exports = jest.fn(() => new RedisMock());
module.exports.default = module.exports;
