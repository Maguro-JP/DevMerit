import type { ScoringAlgorithm } from './algorithm.js';
import { BalancedV1 } from './algorithms/balancedV1.js';

/**
 * Registry of available scoring algorithms.
 *
 * Comparing models on one snapshot is a first-class goal, so algorithms are
 * looked up by id rather than hard-wired into the pipeline.
 */
export class AlgorithmRegistry {
  readonly #byId = new Map<string, ScoringAlgorithm>();

  register(algorithm: ScoringAlgorithm): this {
    this.#byId.set(algorithm.info.id, algorithm);
    return this;
  }

  get(id: string): ScoringAlgorithm | undefined {
    return this.#byId.get(id);
  }

  list(): readonly ScoringAlgorithm[] {
    return [...this.#byId.values()];
  }

  static withDefaults(): AlgorithmRegistry {
    return new AlgorithmRegistry().register(new BalancedV1());
  }
}
