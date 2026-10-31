jest.mock('ioredis', () => jest.fn());
import { redisOptionsFromEnv } from '../redis';

describe('redisOptionsFromEnv', () => {
  it('defaults to 127.0.0.1:6379', () => {
    expect(redisOptionsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ host: '127.0.0.1', port: 6379, password: undefined });
  });
  it('reads REDIS_URL', () => {
    expect(redisOptionsFromEnv({ REDIS_URL: 'redis://:p%40ss@soundsuite-redis:6380/2' } as unknown as NodeJS.ProcessEnv))
      .toEqual({ host: 'soundsuite-redis', port: 6380, password: 'p@ss', db: 2 });
  });
  it('REDIS_HOST/REDIS_PORT win over REDIS_URL', () => {
    expect(redisOptionsFromEnv({ REDIS_URL: 'redis://a:1', REDIS_HOST: 'b', REDIS_PORT: '2' } as unknown as NodeJS.ProcessEnv))
      .toMatchObject({ host: 'b', port: 2 });
  });
  it('REDIS_URL without port uses 6379', () => {
    expect(redisOptionsFromEnv({ REDIS_URL: 'redis://soundsuite-redis' } as unknown as NodeJS.ProcessEnv))
      .toMatchObject({ host: 'soundsuite-redis', port: 6379 });
  });
});
