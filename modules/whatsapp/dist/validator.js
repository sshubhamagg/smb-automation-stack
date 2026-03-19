"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationError = void 0;
exports.verifySignature = verifySignature;
exports.validateInbound = validateInbound;
exports.isE164 = isE164;
exports.validateOutbound = validateOutbound;
const node_crypto_1 = require("node:crypto");
class ValidationError extends Error {
    code;
    field;
    constructor(code, message, field) {
        super(message);
        this.name = 'ValidationError';
        this.code = code;
        this.field = field;
    }
}
exports.ValidationError = ValidationError;
function verifySignature(rawBody, header, secret) {
    try {
        if (!header.startsWith('sha256=')) {
            return false;
        }
        const providedHex = header.slice('sha256='.length);
        const expectedHex = (0, node_crypto_1.createHmac)('sha256', secret).update(rawBody).digest('hex');
        const provided = Buffer.from(providedHex, 'hex');
        const expected = Buffer.from(expectedHex, 'hex');
        if (provided.length !== expected.length) {
            return false;
        }
        return (0, node_crypto_1.timingSafeEqual)(provided, expected);
    }
    catch {
        return false;
    }
}
function assertObject(value, fieldName) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ValidationError('INVALID_PAYLOAD', `Expected object at ${fieldName}`, fieldName);
    }
    return value;
}
function assertArray(value, fieldName) {
    if (!Array.isArray(value)) {
        throw new ValidationError('INVALID_PAYLOAD', `Expected array at ${fieldName}`, fieldName);
    }
    return value;
}
function assertString(value, fieldName) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError('MISSING_FIELD', `Missing or empty string at ${fieldName}`, fieldName);
    }
    return value;
}
function validateInbound(payload) {
    const root = assertObject(payload, 'root');
    const entry = assertArray(root['entry'], 'entry');
    if (entry.length === 0) {
        throw new ValidationError('INVALID_PAYLOAD', 'entry array is empty', 'entry');
    }
    const firstEntry = assertObject(entry[0], 'entry[0]');
    const changes = assertArray(firstEntry['changes'], 'entry[0].changes');
    if (changes.length === 0) {
        throw new ValidationError('INVALID_PAYLOAD', 'changes array is empty', 'changes');
    }
    const firstChange = assertObject(changes[0], 'entry[0].changes[0]');
    const field = firstChange['field'];
    if (field !== 'messages') {
        throw new ValidationError('INVALID_PAYLOAD', `Expected field='messages', got '${String(field)}'`, 'field');
    }
    const value = assertObject(firstChange['value'], 'entry[0].changes[0].value');
    const messagingProduct = value['messaging_product'];
    if (messagingProduct !== 'whatsapp') {
        throw new ValidationError('INVALID_PAYLOAD', `Expected messaging_product='whatsapp', got '${String(messagingProduct)}'`, 'messaging_product');
    }
    const metadata = assertObject(value['metadata'], 'metadata');
    const phoneNumberId = assertString(metadata['phone_number_id'], 'metadata.phone_number_id');
    const messages = value['messages'];
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    const msg = assertObject(messages[0], 'messages[0]');
    const messageId = assertString(msg['id'], 'messages[0].id');
    const from = assertString(msg['from'], 'messages[0].from');
    const timestamp = assertString(msg['timestamp'], 'messages[0].timestamp');
    const type = assertString(msg['type'], 'messages[0].type');
    const result = {
        messageId,
        from,
        timestamp,
        type,
        phoneNumberId,
    };
    if (type === 'text') {
        const textObj = assertObject(msg['text'], 'messages[0].text');
        const body = assertString(textObj['body'], 'messages[0].text.body');
        result.text = { body };
    }
    else {
        const mediaFields = {};
        for (const [k, v] of Object.entries(msg)) {
            if (!['id', 'from', 'timestamp', 'type'].includes(k)) {
                mediaFields[k] = v;
            }
        }
        result.mediaFields = mediaFields;
    }
    return result;
}
function isE164(phone) {
    return /^\+[1-9]\d{7,14}$/.test(phone);
}
function validateOutbound(body) {
    const obj = assertObject(body, 'body');
    const recipient = obj['recipient'];
    if (!recipient || typeof recipient !== 'string') {
        throw new ValidationError('MISSING_FIELD', 'recipient is required', 'recipient');
    }
    if (!isE164(recipient)) {
        throw new ValidationError('INVALID_FORMAT', `recipient must be a valid E.164 phone number, got '${recipient}'`, 'recipient');
    }
    const text = obj['text'];
    if (!text || typeof text !== 'string' || text.trim() === '') {
        throw new ValidationError('MISSING_FIELD', 'text is required and must be non-empty', 'text');
    }
    if (text.length > 4096) {
        throw new ValidationError('INVALID_FORMAT', `text exceeds maximum length of 4096 characters`, 'text');
    }
    const correlationId = obj['correlationId'];
    if (!correlationId || typeof correlationId !== 'string') {
        throw new ValidationError('MISSING_FIELD', 'correlationId is required', 'correlationId');
    }
    return { recipient, text, correlationId };
}
