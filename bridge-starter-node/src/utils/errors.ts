export const formatErrorResponse = (
  statusCode: number,
  code: string,
  message: string,
  requestId?: string,
  details?: Record<string, unknown>,
) => ({
  code,
  message,
  message_en: message,
  timestamp: new Date().toISOString(),
  statusCode,
  requestId,
  details,
  error: message,
});
