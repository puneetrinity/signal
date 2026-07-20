import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

const rootLogger = isProd ? pino({
  level: process.env.LOG_LEVEL || 'info',
}) : pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      { target: 'pino-pretty', options: {} },
      {
        target: 'pino/file',
        options: { destination: './worker.log', mkdir: true }
      }
    ]
  }
});

export function createLogger(module: string) {
  return rootLogger.child({ module });
}

export default rootLogger;
