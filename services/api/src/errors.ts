export type DomainErrorKind =
  | "NotFound"
  | "Validation"
  | "Conflict"
  | "Provider"
  | "Cancelled"
  | "Unauthorized"
  | "Internal";

export interface DomainErrorPayload {
  kind: DomainErrorKind;
  message: string;
  resource?: string;
  details?: Record<string, unknown>;
}

export class DomainError extends Error {
  readonly kind: DomainErrorKind;
  readonly resource?: string;
  readonly details?: Record<string, unknown>;

  constructor(payload: DomainErrorPayload) {
    super(payload.message);
    this.name = `DomainError(${payload.kind})`;
    this.kind = payload.kind;
    this.resource = payload.resource;
    this.details = payload.details;
  }
}

export function notFound(resource: string, message?: string): DomainError {
  return new DomainError({
    kind: "NotFound",
    resource,
    message: message ?? `${resource} not found`,
  });
}

export function validation(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError({ kind: "Validation", message, details });
}

export function conflict(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError({ kind: "Conflict", message, details });
}

export function providerError(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError({ kind: "Provider", message, details });
}

export function cancelled(message = "Operation was cancelled"): DomainError {
  return new DomainError({ kind: "Cancelled", message });
}

export function unauthorized(message: string): DomainError {
  return new DomainError({ kind: "Unauthorized", message });
}

export function internal(message: string, cause?: unknown): DomainError {
  return new DomainError({
    kind: "Internal",
    message,
    details: cause ? { cause: String(cause) } : undefined,
  });
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

const STATUS_BY_KIND: Record<DomainErrorKind, number> = {
  NotFound: 404,
  Validation: 400,
  Conflict: 409,
  Provider: 502,
  Cancelled: 499,
  Unauthorized: 401,
  Internal: 500,
};

export function httpStatusForDomainError(error: DomainError): number {
  return STATUS_BY_KIND[error.kind];
}

export function domainErrorToJson(error: DomainError): { error: DomainErrorPayload } {
  return {
    error: {
      kind: error.kind,
      message: error.message,
      resource: error.resource,
      details: error.details,
    },
  };
}
