/**
 * Message of the 409 for a target whose tag variable is already a variable of
 * its environment: the deploy writes the tag line itself, so the two would
 * clash. The UI matches it to show its own text.
 */
export const TAG_VARIABLE_IS_VARIABLE_MESSAGE =
  "The tag variable is already a variable of this environment";
