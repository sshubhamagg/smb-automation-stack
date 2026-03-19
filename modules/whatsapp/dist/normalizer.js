"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toE164 = toE164;
exports.epochToIso = epochToIso;
exports.mapMessageType = mapMessageType;
exports.normalize = normalize;
const node_crypto_1 = require("node:crypto");
function toE164(rawPhone) {
    return '+' + rawPhone;
}
function epochToIso(tsString) {
    return new Date(Number(tsString) * 1000).toISOString();
}
function mapMessageType(providerType) {
    if (providerType === 'text')
        return 'text';
    return 'unsupported';
}
function normalize(payload) {
    const messageType = mapMessageType(payload.type);
    const result = {
        message_id: payload.messageId,
        correlation_id: (0, node_crypto_1.randomUUID)(),
        phone_number: toE164(payload.from),
        timestamp: epochToIso(payload.timestamp),
        message_type: messageType,
        status: 'received',
        received_at: new Date().toISOString(),
    };
    if (messageType === 'text' && payload.text) {
        result.text_body = payload.text.body;
    }
    if (messageType === 'unsupported' && payload.mediaFields) {
        result.media_metadata = payload.mediaFields;
    }
    return result;
}
