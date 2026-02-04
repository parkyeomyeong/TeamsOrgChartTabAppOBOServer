import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const logDir = 'logs';

// 한국 시간(KST) 반환 헬퍼 (YYYY-MM-DD HH:mm:ss)
const koreanTime = () => new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
}).replace(/\. /g, '-').replace('.', ''); // 2026. 02. 03. -> 2026-02-03 포맷 보정

const timestampFormat = winston.format.timestamp({ format: koreanTime });
const printFormat = winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message} `;
});

// 공통 Transports 생성 함수 (폴더 분리)
const createDailyRotateTransport = (folder: string, level: string) => {
    return new DailyRotateFile({
        level: level,
        datePattern: 'YYYY-MM-DD', // [설정] 이거 하면 해당 패턴에 따라 매일 파일이 새로 생성됨 (하루 단위)
        dirname: path.join(logDir, folder),
        filename: `%DATE%.log`,
        maxFiles: '180d', // [설정] 180일 지난 로그는 자동으로 삭제됨
        zippedArchive: true, // [설정] 지난 로그는 .gz로 압축하여 용량을 아낌 (1/10으로 줄어든다고 함)
    });
};

// 1. Request Logger (requests.log) - 통계용
//    - HTTP 요청/응답 요약 정보만 저장
//    - [수정] 자체 포맷에서 타임스탬프 제거 (메시지 안에 Start-End가 이미 포함됨)
export const requestLogger = winston.createLogger({
    level: 'info',
    format: winston.format.printf(({ message }) => {
        return message as string; // 시간, 레벨 다 빼고 메시지만 깔끔하게 저장
    }),
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
