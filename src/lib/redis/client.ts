import Redis from 'ioredis';

type RedisGlobal = {
  redis: Redis | NoopRedis | undefined;
  redisListenersRegistered?: boolean;
  redisCleanupRegistered?: boolean;
  redisDisabledLogged?: boolean;
};

const globalForRedis = globalThis as unknown as RedisGlobal;

/**
 * Detect if we're in a build environment (Docker build, next build, etc.)
 * During build, network is often unavailable and env vars may not be set correctly
 *
 * NOTE: This only returns true for Next.js static generation.
 * At runtime (including worker processes), Redis should always connect.
 */
function isBuildTime(): boolean {
  // Next.js sets this during static page generation
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return true;
  }
  // Explicit build flag (set in Dockerfile/CI)
  if (process.env.BUILDING === 'true') {
    return true;
  }
  return false;
}

class NoopRedis {
  on(_event: string, _listener: (...args: unknown[]) => void) {
    return this;
  }

  async get(_key: string) {
    return null;
  }

  async setex(_key: string, _ttl: number, _value: string) {
    return 'OK';
  }

  async del(..._keys: string[]) {
    return 0;
  }

  async keys(_pattern: string) {
    return [];
  }

  async exists(_key: string) {
    return 0;
  }

  async ttl(_key: string) {
    return -1;
  }

  async mget(...keys: string[]) {
    return keys.map(() => null);
  }

  async incr(_key: string) {
    return 0;
  }

  async expire(_key: string, _ttl: number) {
    return 0;
  }

  async ping() {
    return 'DISABLED';
  }

  async info() {
    return '';
  }

  async quit() {
    return 'OK';
  }
}

type RedisClient = Redis | NoopRedis;

function createRedisClient(): RedisClient {
  // During build time, always return NoopRedis to avoid network issues
  if (isBuildTime()) {
    if (!globalForRedis.redisDisabledLogged) {
      console.log('[Redis] Build-time detected, using NoopRedis');
      globalForRedis.redisDisabledLogged = true;
    }
    return new NoopRedis();
  }

  if (process.env.REDIS_URL) {
    return new Redis(process.env.REDIS_URL, {
      tls: process.env.REDIS_TLS_ENABLED === 'true' ? {} : undefined,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNRESET'];
        return targetErrors.some((code) => err.message.includes(code));
      },
      lazyConnect: true, // Don't connect immediately - wait for first command
      enableReadyCheck: true,
      showFriendlyErrorStack: process.env.NODE_ENV === 'development',
    });
  }

  if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
    return new Redis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS_ENABLED === 'true' ? {} : undefined,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNRESET'];
        return targetErrors.some((code) => err.message.includes(code));
      },
      lazyConnect: true, // Don't connect immediately - wait for first command
      enableReadyCheck: true,
      showFriendlyErrorStack: process.env.NODE_ENV === 'development',
    });
  }

  if (!globalForRedis.redisDisabledLogged && process.env.NODE_ENV !== 'test') {
    console.warn(
      '[Redis] Redis is not configured (set REDIS_URL or REDIS_HOST/REDIS_PORT). Continuing without Redis hot cache.',
    );
    globalForRedis.redisDisabledLogged = true;
  }

  return new NoopRedis();
}

const redisInstance =
  globalForRedis.redis ?? createRedisClient();

const isRealRedisClient = redisInstance instanceof Redis;

if (isRealRedisClient && !globalForRedis.redisListenersRegistered) {
  redisInstance.on('connect', () => {
    console.log('[Redis] Connected to Redis Cloud');
  });

  redisInstance.on('ready', () => {
    console.log('[Redis] Redis client ready');
  });

  redisInstance.on('error', (err) => {
    console.error('[Redis] Redis error:', err);
  });

  redisInstance.on('close', () => {
    console.warn('[Redis] Redis connection closed');
  });

  redisInstance.on('reconnecting', () => {
    console.log('[Redis] Reconnecting to Redis...');
  });

  globalForRedis.redisListenersRegistered = true;
}

if (isRealRedisClient && !globalForRedis.redisCleanupRegistered) {
  process.on('SIGTERM', async () => {
    console.log('[Redis] SIGTERM received, closing Redis connection');
    try {
      await redisInstance.quit();
    } catch (error) {
      console.error('[Redis] Error closing connection on SIGTERM:', error);
    }
  });

  globalForRedis.redisCleanupRegistered = true;
}

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redisInstance;
}

export const redis: RedisClient = redisInstance;
export default redis;
