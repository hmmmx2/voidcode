/**
 * The porting gate, for the curriculum problems that needed one.
 *
 * Same contract as the individual checks in `index.ts`: derive the answer key by executing the
 * reference, prove a correct-but-differently-written solution is accepted, and prove each named trap
 * has a case that actually catches it.
 *
 * The table itself is in `verify-curriculum-specs.ts`, which is data behind a type-only import and
 * therefore readable without booting Electron. That split is what lets the catalogue export hand the
 * same correct-variants and mutants to the Python reward harness; see that file's header.
 */
import { getProblem } from "./problems.js";
// The loop and the `Spec` shape moved to `verify-spec.ts` when the interview problems needed the
// same three assertions.
import { verifyAgainstSpecs } from "./verify-spec.js";
import { CURRICULUM_SPECS } from "./verify-curriculum-specs.js";

export async function verifyRemainingCurriculum(): Promise<string[]> {
  return verifyAgainstSpecs(CURRICULUM_SPECS, getProblem, "problem");
}
