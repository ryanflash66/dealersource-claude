import type { PaidCall } from "../core/types.js";
import type { HttpClient, HttpRequest, HttpResponse } from "./client.js";
import type { Clock } from "../core/clock.js";

/**
 * Records every call made through a paid/metered adapter so the run row can
 * show exactly what would have cost money. The acceptance test asserts this
 * ledger is empty for the default configuration.
 */
export class CostLedger {
  readonly calls: PaidCall[] = [];
  record(call: PaidCall): void {
    this.calls.push(call);
  }
}

export class PaidProviderDisabledError extends Error {
  constructor(adapter: string) {
    super(
      `Adapter "${adapter}" is a PAID provider but providers.paid_enabled is false. ` +
        `Set paid_enabled: true in config/providers.yaml to allow spend (see docs/costs.md).`,
    );
  }
}

/** Wraps an HttpClient so each request is logged to the ledger with a cost class. */
export class MeteredHttpClient implements HttpClient {
  constructor(
    private readonly inner: HttpClient,
    private readonly adapter: string,
    private readonly costClass: PaidCall["cost_class"],
    private readonly ledger: CostLedger,
    private readonly clock: Clock,
  ) {}
  get kind() {
    return this.inner.kind;
  }
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.ledger.record({ adapter: this.adapter, cost_class: this.costClass, url: req.url, at: this.clock.iso() });
    return this.inner.request(req);
  }
}
