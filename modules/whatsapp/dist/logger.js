"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLogger = initLogger;
exports.maskPii = maskPii;
exports.truncateText = truncateText;
exports.truncatePayload = truncatePayload;
exports.log = log;
const LEVEL_ORDER = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};
let _config = null;
function initLogger(config) {
    _config = config;
}
function maskPii(phone) {
    if (phone.length <= 7) {
        return phone;
    }
    const prefix = phone.slice(0, 3);
    const suffix = phone.slice(-4);
    const middleLength = phone.length - 7;
    const masked = '*'.repeat(middleLength);
    return `${prefix}${masked}${suffix}`;
}
function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + '\u2026';
}
function truncatePayload(payload, maxBytes) {
    let serialized;
    try {
        serialized = JSON.stringify(payload);
    }
    catch {
        return { data: '[unserializable]', truncated: true };
    }
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength <= maxBytes) {
        return { data: payload, truncated: false };
    }
    const truncatedStr = serialized.slice(0, maxBytes);
    try {
        const parsed = JSON.parse(truncatedStr);
        return { data: parsed, truncated: true };
    }
    catch {
        return { data: '[truncated]', truncated: true };
    }
}
function log(entry) {
    const configLogLevel = _config?.logLevel ?? 'INFO';
    const configMaxPayloadBytes = _config?.logMaxPayloadBytes ?? 2048;
    const entryOrder = LEVEL_ORDER[entry.level] ?? 1;
    const configOrder = LEVEL_ORDER[configLogLevel] ?? 1;
    if (entryOrder < configOrder) {
        return;
    }
    const output = {
        timestamp: new Date().toISOString(),
        level: entry.level,
        status: entry.status,
        correlationId: entry.correlationId,
        direction: entry.direction,
    };
    if (entry.messageId !== undefined) {
        output['messageId'] = entry.messageId;
    }
    if (entry.userId !== undefined) {
        output['userId'] = maskPii(entry.userId);
    }
    if (entry.durationMs !== undefined) {
        output['durationMs'] = entry.durationMs;
    }
    if (entry.error !== undefined) {
        output['error'] = entry.error;
    }
    if (entry.normalizedOutput !== undefined) {
        const { data, truncated } = truncatePayload(entry.normalizedOutput, 1024);
        output['normalizedOutput'] = data;
        if (truncated) {
            output['_normalizedOutput_truncated'] = true;
        }
    }
    if (entry.rawPayload !== undefined) {
        const { data, truncated } = truncatePayload(entry.rawPayload, configMaxPayloadBytes);
        output['rawPayload'] = data;
        if (truncated) {
            output['_rawPayload_truncated'] = true;
        }
    }
    process.stdout.write(JSON.stringify(output) + '\n');
}
