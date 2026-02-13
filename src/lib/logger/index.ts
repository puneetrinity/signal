import pino from 'pino';

const rootLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
    },
  }),
});

export function createLogger(module: string) {
  return rootLogger.child({ module });
}

export default rootLogger;
