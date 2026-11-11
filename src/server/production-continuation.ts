import { DomainError } from "@/domain/primitives";

/** The saved operation is unfinished; release the worker lease and resume it later. */
export class ProductionContinuation extends Error {
  constructor(public step: string, public retryAfterSeconds = 10) { super(step); this.name = "ProductionContinuation"; }
}

/** A retained operation cannot safely be replaced with a new provider request. */
export class ProductionReviewRequired extends DomainError {
  constructor(code: string, message: string) { super(code, message, 409, false); this.name = "ProductionReviewRequired"; }
}
