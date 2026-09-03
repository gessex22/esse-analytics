import { NextFunction, Request, Response } from 'express';
import { logger, errorName } from '../utils/logger';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ message: 'Ruta no encontrada.' });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('request_failed', { requestId: res.locals.requestId, errorName: errorName(err) });
  if (res.headersSent) {
    _next(err);
    return;
  }
  res.status(500).json({ message: 'Error interno.', requestId: res.locals.requestId });
}
