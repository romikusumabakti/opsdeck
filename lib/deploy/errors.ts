/**
 * Message of the 409 for a target whose component belongs to another app than
 * its environment. The UI matches it to tell this 409 from the duplicate-target
 * one (ApiError carries only status and message).
 */
export const COMPONENT_OTHER_APP_MESSAGE =
  "Component belongs to another app than this environment";

/**
 * Message of the 409 for a target whose tag variable is already a variable of
 * its environment: the deploy writes the tag line itself, so the two would
 * clash. The UI matches it to show its own text.
 */
export const TAG_VARIABLE_IS_VARIABLE_MESSAGE =
  "The tag variable is already a variable of this environment";
