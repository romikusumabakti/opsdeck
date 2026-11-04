/**
 * Message of the 409 for a target whose component belongs to another app than
 * its environment. The UI matches it to tell this 409 from the duplicate-target
 * one (ApiError carries only status and message).
 */
export const COMPONENT_OTHER_APP_MESSAGE =
  "Component belongs to another app than this environment";
