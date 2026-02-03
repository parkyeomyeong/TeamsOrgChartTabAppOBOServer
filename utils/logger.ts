import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const logDir = 'logs';

const koreanTime = () => {
    return new Date().toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour12: false
    });
};

const timestampFormat = winston.format.timestamp({ format: koreanTime });
const printFormat = winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

// 공통 Transports 생성 함수 (폴더 분리)
const createDailyRotateTransport = (folder: string, level: string) => {
    return new DailyRotateFile({
        level: level,
        datePattern: 'YYYY-MM-DD',
        dirname: path.join(logDir, folder), // logs/requests, logs/app 등으로 분리
        filename: `%DATE%.log`, // 파일명은 날짜만 (폴더로 구분되므로)
        maxFiles: '30d',
        zippedArchive: true,
    });
};

// 1. Request Logger (requests.log) - 통계용
//    - HTTP 요청/응답 요약 정보만 저장
export const requestLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(timestampFormat, printFormat),
    transports: [
        createDailyRotateTransport('requests', 'info'),
    ]
});

// 2. App Logger (app.log) - 디버깅용
//    - 내부 로직, DB 쿼리 flow, 상세 정보 저장
export const appLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(timestampFormat, printFormat),
    transports: [
        createDailyRotateTransport('app', 'info'),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                timestampFormat,
                printFormat
            )
        })
    ]
});

// 3. Error Logger (error.log) - 비상용
//    - 에러만 따로 저장
export const errorLogger = winston.createLogger({
    level: 'error',
    format: winston.format.combine(timestampFormat, printFormat),
    transports: [
        createDailyRotateTransport('error', 'error'),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                timestampFormat,
                printFormat
            )
        })
    ]
});

// Default export for backward compatibility (optional)
export default {
    info: (msg: string) => appLogger.info(msg),
    warn: (msg: string) => appLogger.warn(msg),
    error: (msg: string) => errorLogger.error(msg),
    http: (msg: string) => requestLogger.info(msg),
};
