export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function invariant(
  condition: unknown,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new ApiError(statusCode, code, message, details);
}
