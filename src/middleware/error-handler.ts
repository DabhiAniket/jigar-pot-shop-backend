import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError, isDuplicateKeyError } from '../lib/errors';
import { reportError } from '../lib/error-reporter';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: req.id } });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const requestId = String(req.id ?? '');
  const send = (status: number, code: string, message: string, fields?: Record<string, string[]>) =>
    res.status(status).json({ error: { code, message, ...(fields ? { fields } : {}), requestId } });

  if (error instanceof AppError) {
    send(error.status, error.code, error.message, error.fields);
    return;
  }
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      send(413, 'FILE_TOO_LARGE', 'The file is too large.');
    } else {
      send(400, 'UPLOAD_ERROR', 'The upload could not be read. Please try again.');
    }
    return;
  }
  const typed = error as { type?: string; status?: number };
  if (typed.type === 'entity.too.large') {
    send(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
    return;
  }
  if (typed.type === 'entity.parse.failed') {
    send(400, 'INVALID_JSON', 'The request body is not valid JSON.');
    return;
  }
  if (typed.status === 404 || (error as { code?: string }).code === 'ENOENT') {
    // e.g. express.static for a media file that no longer exists
    send(404, 'NOT_FOUND', 'Not found.');
    return;
  }
  if (error instanceof mongoose.Error.CastError) {
    send(400, 'INVALID_ID', 'Invalid identifier.');
    return;
  }
  if (error instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string[]> = {};
    for (const [path, detail] of Object.entries(error.errors)) fields[path] = [detail.message];
    send(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', fields);
    return;
  }
  if (isDuplicateKeyError(error)) {
    send(409, 'DUPLICATE', 'A record with the same unique value already exists.');
    return;
  }

  reportError(error, { requestId, method: req.method, path: req.path });
  send(500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again.');
};
