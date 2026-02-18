import winston from 'winston';

const { combine, timestamp, label: labelFormat, colorize, printf } = winston.format;

const logFormat = printf(({ level, message, label, timestamp }) => {
  return `${timestamp} [${label}] ${level}: ${message}`;
});

export function createLogger(label) {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      labelFormat({ label }),
      colorize(),
      logFormat
    ),
    transports: [new winston.transports.Console()]
  });
}
