import { randomUUID } from 'node:crypto';

export function requestContext(req, res, next) {
  req.requestId = req.get('x-request-id') || randomUUID();
  res.set('x-request-id', req.requestId);
  next();
}

export function errorResponse(res, requestId, status, code, message, retryable = false) {
  return res.status(status).json({
    error: { code, message, retryable, requestId },
  });
}
