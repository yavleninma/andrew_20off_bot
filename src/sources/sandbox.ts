import { SimulatedDealsSource } from "./simulated.js";

/**
 * Sandbox mode for safe integration tests.
 * Uses deterministic synthetic deals to validate end-to-end bot flow.
 */
export class SandboxDealsSource extends SimulatedDealsSource {
  constructor() {
    super("always", "sandbox");
  }

  getName(): string {
    return "sandbox";
  }
}
